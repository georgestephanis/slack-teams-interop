/**
 * Microsoft Teams Adapter
 * Bridges Microsoft Teams using Bot Framework SDK v4 and Resource-Specific Consent (RSC).
 */

import {
  Activity,
  ActivityTypes,
  CardFactory,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConversationReference,
  InvokeResponse,
  MessageFactory,
  StatusCodes,
  TeamsActivityHandler,
  TurnContext,
} from 'botbuilder';
import { AuthenticateRequestResult, AuthenticationError, MicrosoftAppCredentials } from 'botframework-connector';
import { BridgeAdapter, BridgeCore } from '../../core/bridge.js';
import { MessageTranslator } from '../../core/translator.js';
import { MAX_TRANSFER_BYTES } from '../../core/media.js';
import { teamsInstallationKey } from '../../db/index.js';
import {
  Attachment,
  ChannelMapping,
  isImageAttachment,
  NormalizedMessage,
  NormalizedReaction,
  Platform,
  UserIdentity,
} from '../../core/types.js';

export interface TeamsAdapterConfig {
  appId: string;
  appPassword?: string;
  appTenantId?: string;
  /**
   * Azure Bot registration type. New registrations must be SingleTenant (Microsoft stopped
   * creating multi-tenant bots after July 2025); SingleTenant requires appTenantId.
   */
  appType?: 'SingleTenant' | 'MultiTenant';
  serviceUrl?: string; // Default Azure Bot service URL: https://smba.trafficmanager.net/amer/
}

/** One Azure Bot registration the adapter can receive from and post as. */
export interface TeamsConnectionConfig extends TeamsAdapterConfig {
  /** Slug that names the connection in mappings and in its webhook path (`/api/messages/<id>`) */
  id: string;
  name?: string;
}

interface TeamsConnection {
  id: string;
  name: string;
  config: TeamsAdapterConfig;
  cloudAdapter: CloudAdapter;
}

export interface TeamsAdapterOptions {
  /** Id of the connection built from the constructor config (TEAMS_CONNECTION_ID). */
  defaultConnectionId?: string;
  /** Service URL used when nothing is known for a channel and its connection sets none. */
  serviceUrl?: string;
}

export const DEFAULT_TEAMS_CONNECTION_ID = 'default';
const DEFAULT_SERVICE_URL = 'https://smba.trafficmanager.net/amer/';
/** turnState key holding the connection an inbound activity arrived on */
const CONNECTION_KEY = Symbol('interbridge.teamsConnection');

/**
 * A post failed because the connection's bot isn't installed in the target team (Teams answers
 * 403 BotNotInConversationRoster). Logged as one line: the fix is in Teams, not in the bridge.
 */
export class TeamsNotInstalledError extends Error {
  constructor(
    public readonly team: string,
    public readonly connectionId: string,
    options?: { cause?: unknown }
  ) {
    super(
      `InterBridge isn't installed in the Teams team ${team} (connection "${connectionId}"), so Teams refused the post. ` +
        'Add the app to that team (in Teams: Apps > Manage your apps > Add to a team), then post again.',
      options
    );
    this.name = 'TeamsNotInstalledError';
  }
}

/** True for Teams' "the bot is not part of the conversation roster" rejection. */
export function isNotInConversationRoster(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number; message?: string } | undefined;
  return e?.code === 'BotNotInConversationRoster' || (e?.statusCode === 403 && /conversation roster/i.test(e.message || ''));
}

/** Most recent failed post into a Teams channel, cleared by the next successful one. */
export interface TeamsDeliveryFailure {
  at: string;
  error: string;
  notInstalled: boolean;
}

/**
 * Teams side of the bridge. Holds one Bot Framework adapter per connection (Azure Bot), so a
 * single instance can bridge channels in several Microsoft 365 tenants. Inbound activities are
 * authenticated by the connection whose webhook they arrived on; outbound calls use the
 * connection of the channel mapping.
 */
export class TeamsAdapter extends TeamsActivityHandler implements BridgeAdapter {
  public platform: Platform = 'teams';
  public readonly defaultConnectionId: string;
  private connections = new Map<string, TeamsConnection>();
  private fallbackServiceUrl: string;
  /** In-memory cache in front of the persisted teams_conversations table */
  private serviceUrlMap = new Map<string, string>();
  private warnedFallbackChannels = new Set<string>();
  /** Last failed post per Teams channel (in memory), for the dashboard */
  private deliveryFailures = new Map<string, TeamsDeliveryFailure>();

  /**
   * @param config The TEAMS_APP_ID bot, registered as the default connection. Optional: more
   *   connections can be added later with addConnection.
   */
  constructor(
    config: TeamsAdapterConfig | undefined,
    private bridge: BridgeCore,
    options: TeamsAdapterOptions = {}
  ) {
    super();
    this.defaultConnectionId = options.defaultConnectionId || DEFAULT_TEAMS_CONNECTION_ID;
    this.fallbackServiceUrl = options.serviceUrl || config?.serviceUrl || DEFAULT_SERVICE_URL;

    if (config?.appId) {
      this.addConnection({ ...config, id: this.defaultConnectionId });
    }

    this.setupHandlers();
  }

  /**
   * Register (or replace) a connection. Takes effect immediately for both its webhook and
   * outbound posts.
   */
  addConnection(connection: TeamsConnectionConfig): void {
    const { id, name, ...config } = connection;
    if (config.appType === 'SingleTenant' && !config.appTenantId) {
      throw new Error('Teams SingleTenant bots require a tenant ID (TEAMS_TENANT_ID)');
    }

    const botAuth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: config.appId,
      MicrosoftAppPassword: config.appPassword,
      MicrosoftAppTenantId: config.appTenantId,
      MicrosoftAppType: config.appType ?? 'MultiTenant',
    });
    const cloudAdapter = new QuietAuthCloudAdapter(botAuth, id);

    // Report and swallow: rethrowing here returns a 500 to Bot Framework, which redelivers the activity.
    cloudAdapter.onTurnError = async (_context, error) => {
      const cause = error instanceof Error ? error : new Error(String(error));
      this.bridge.emit('error', new Error(`Teams Turn Error (${id}): ${cause.message}`, { cause }));
    };

    // Every connection's bot posts into bridged channels, so all of them must be filtered as bots
    this.bridge.dedup.registerBotId('teams', config.appId);
    this.connections.set(id, { id, name: name || id, config, cloudAdapter });
  }

  /** Stop receiving from and posting as a connection. Returns false if it wasn't registered. */
  removeConnection(id: string): boolean {
    return this.connections.delete(id);
  }

  hasConnection(id: string): boolean {
    return this.connections.has(id);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Public details of the registered connections (no secrets). */
  listConnections(): { id: string; name: string; appId: string; tenantId?: string; appType: string }[] {
    return [...this.connections.values()].map((c) => ({
      id: c.id,
      name: c.name,
      appId: c.config.appId,
      tenantId: c.config.appTenantId,
      appType: c.config.appType ?? 'MultiTenant',
    }));
  }

  /** Bot Framework adapter of the default connection (the TEAMS_APP_ID bot). */
  get adapter(): CloudAdapter {
    return this.requireConnection(this.defaultConnectionId).cloudAdapter;
  }

  private requireConnection(id: string): TeamsConnection {
    const connection = this.connections.get(id);
    if (!connection) throw new Error(`Teams connection "${id}" is not configured`);
    return connection;
  }

  /** Connection a channel mapping posts through. */
  private connectionFor(mapping: ChannelMapping): TeamsConnection {
    return this.requireConnection(mapping.teams.connectionId || this.defaultConnectionId);
  }

  /** Connection an inbound activity arrived on. */
  private connectionOf(context: TurnContext): TeamsConnection {
    const connection = context.turnState.get(CONNECTION_KEY) as TeamsConnection | undefined;
    return connection ?? this.requireConnection(this.defaultConnectionId);
  }

  /**
   * True when an inbound activity's tenant matches its connection. A single-tenant bot's tokens
   * are only valid in its own tenant, so a mismatch means misrouted or forged traffic.
   */
  private tenantMatches(connection: TeamsConnection, activity: Partial<Activity>): boolean {
    const expected = connection.config.appTenantId;
    const actual: string | undefined = activity.channelData?.tenant?.id || activity.conversation?.tenantId;
    return !expected || !actual || connection.config.appType !== 'SingleTenant' || expected === actual;
  }

  /**
   * True unless the channel is bridged through a *different* connection. Unmapped channels pass,
   * and BridgeCore ignores them as before.
   */
  private acceptsChannel(context: TurnContext, channelId: string): boolean {
    const mapping = this.bridge.db.findMappingByTeamsChannel(channelId);
    if (!mapping) return true;
    const connection = this.connectionOf(context);
    const expected = mapping.teams.connectionId || this.defaultConnectionId;
    if (expected === connection.id) return true;
    this.bridge.emit(
      'error',
      new Error(`Teams activity for ${channelId} arrived on connection "${connection.id}", but its bridge uses "${expected}"; ignored`)
    );
    return false;
  }

  /** True if an id is the connection's bot (Teams may send it with or without the '28:' prefix). */
  private isOwnBot(connection: TeamsConnection, id: string | undefined): boolean {
    const bareAppId = connection.config.appId.replace(/^28:/, '');
    return id === bareAppId || id === `28:${bareAppId}`;
  }

  private setupHandlers(): void {
    // 0. Reject activities from a tenant other than the connection's. Then remember the service
    // URL from every inbound activity (messages, installs, channel updates, reactions), so
    // outbound posts reach the right region even before anyone speaks.
    this.onTurn(async (context: TurnContext, next) => {
      const connection = this.connectionOf(context);
      if (!this.tenantMatches(connection, context.activity)) {
        this.bridge.emit(
          'error',
          new Error(`Teams activity from another tenant arrived on connection "${connection.id}"; ignored`)
        );
        return;
      }
      this.rememberServiceUrl(context.activity);
      this.trackInstallation(context.activity, connection);
      await next();
    });

    // 1. Process all incoming channel messages (captured via Resource-Specific Consent)
    this.onMessage(async (context: TurnContext, next) => {
      const activity = context.activity;
      const connection = this.connectionOf(context);

      // Check if message is from the bot itself
      if (this.isOwnBot(connection, activity.from?.id)) {
        await next();
        return;
      }

      const text = activity.text?.trim() || '';
      const attachments = teamsAttachments(activity, (url) => this.downloadAttachment(url, connection.id));
      const unsupported = teamsUnsupportedContent(activity);
      if (!text && !attachments && !unsupported) {
        await next();
        return;
      }

      const teamsChannelId = activity.channelData?.channel?.id || activity.conversation?.id;
      if (!this.acceptsChannel(context, teamsChannelId)) {
        await next();
        return;
      }
      const teamsTeamId = activity.channelData?.team?.id || '';

      const sender: UserIdentity = {
        platformId: activity.from?.id || activity.from?.aadObjectId || 'unknown',
        displayName: activity.from?.name || 'Teams User',
        platform: 'teams',
        isBot: activity.from?.role === 'bot' || Boolean(activity.from?.id?.startsWith('28:')),
      };

      const normalized: NormalizedMessage = {
        id: `teams-${teamsChannelId}-${activity.id}`,
        sourcePlatform: 'teams',
        sourceChannelId: teamsChannelId,
        sourceTeamId: teamsTeamId,
        sourceMessageId: activity.id || `${Date.now()}`,
        sourceParentId: activity.replyToId,
        sender,
        content: text,
        attachments,
        unsupported,
        timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
        rawEvent: activity,
      };

      await this.bridge.handleIncomingMessage(normalized);
      await next();
    });

    // 2. Edits and (soft) deletes of channel messages
    this.onTeamsMessageEditEvent(async (context: TurnContext, next) => {
      const activity = context.activity;
      const connectionId = this.connectionOf(context).id;
      const text = activity.text?.trim() || '';
      const attachments = teamsAttachments(activity, (url) => this.downloadAttachment(url, connectionId));
      const teamsChannelId = this.channelIdOf(activity);
      // Attachment-only edits are relayed too; BridgeCore drops them if syncFiles is off
      if (activity.id && (text || attachments) && this.acceptsChannel(context, teamsChannelId)) {
        await this.bridge.handleIncomingEdit({
          id: `teams-edit-${teamsChannelId}-${activity.id}`,
          sourcePlatform: 'teams',
          sourceChannelId: teamsChannelId,
          sourceTeamId: activity.channelData?.team?.id,
          sourceMessageId: activity.id,
          sourceParentId: activity.replyToId,
          sender: {
            platformId: activity.from?.id || 'unknown',
            displayName: activity.from?.name || 'Teams User',
            platform: 'teams',
          },
          content: text,
          attachments,
          timestamp: new Date(),
          rawEvent: activity,
        });
      }
      await next();
    });

    this.onTeamsMessageSoftDeleteEvent(async (context: TurnContext, next) => {
      const activity = context.activity;
      const teamsChannelId = this.channelIdOf(activity);
      if (activity.id && this.acceptsChannel(context, teamsChannelId)) {
        await this.bridge.handleIncomingDelete({
          sourcePlatform: 'teams',
          sourceChannelId: teamsChannelId,
          sourceMessageId: activity.id,
          senderId: activity.from?.id,
        });
      }
      await next();
    });

    // 3. Reactions (added and removed)
    const forwardReactions = async (context: TurnContext, action: 'add' | 'remove') => {
      const activity = context.activity;
      const reactions = action === 'add' ? activity.reactionsAdded : activity.reactionsRemoved;
      const messageId = activity.replyToId || activity.id || '';
      const teamsChannelId = this.channelIdOf(activity);
      // Outside a channel (or if Teams omits ids) there's nothing to key the reaction to
      if (!messageId || !teamsChannelId || !this.acceptsChannel(context, teamsChannelId)) return;

      for (const r of reactions || []) {
        await this.bridge.handleIncomingReaction({
          id: `teams-reaction-${messageId}-${r.type}`,
          sourcePlatform: 'teams',
          sourceChannelId: teamsChannelId,
          sourceMessageId: messageId,
          sender: {
            platformId: activity.from?.id || 'unknown',
            displayName: activity.from?.name || 'Teams User',
            platform: 'teams',
          },
          emoji: r.type,
          action,
        });
      }
    };

    this.onReactionsAdded(async (context: TurnContext, next) => {
      await forwardReactions(context, 'add');
      await next();
    });

    this.onReactionsRemoved(async (context: TurnContext, next) => {
      await forwardReactions(context, 'remove');
      await next();
    });
  }

  /**
   * Record the Bot Framework service URL for the conversation, channel, and team of an activity.
   */
  rememberServiceUrl(activity: Partial<Activity>): void {
    const serviceUrl = activity.serviceUrl;
    if (!serviceUrl) return;

    const teamId: string | undefined = activity.channelData?.team?.id;
    const tenantId: string | undefined = activity.channelData?.tenant?.id || activity.conversation?.tenantId;
    const ids = new Set<string>();
    // Threaded conversation ids look like `<channelId>;messageid=<rootId>`
    if (activity.conversation?.id) ids.add(activity.conversation.id.split(';')[0]);
    if (activity.channelData?.channel?.id) ids.add(activity.channelData.channel.id);

    for (const id of ids) {
      if (this.serviceUrlMap.get(id) === serviceUrl) continue;
      this.serviceUrlMap.set(id, serviceUrl);
      try {
        this.bridge.db.saveTeamsServiceUrl(id, serviceUrl, teamId, tenantId);
      } catch (err) {
        this.bridge.emit('error', err);
      }
    }
  }

  /**
   * Record and log the bot being added to or removed from a team. Teams reports this as an
   * installationUpdate, a conversationUpdate whose membersAdded/membersRemoved includes the bot,
   * or both; only a change of state is logged.
   */
  private trackInstallation(activity: Partial<Activity>, connection: TeamsConnection): void {
    const team = activity.channelData?.team as { id?: string; name?: string } | undefined;
    if (!team?.id) return;

    let installed: boolean | undefined;
    if (activity.type === ActivityTypes.InstallationUpdate) {
      if (activity.action?.startsWith('add')) installed = true;
      else if (activity.action?.startsWith('remove')) installed = false;
    } else if (activity.type === ActivityTypes.ConversationUpdate) {
      if (activity.membersAdded?.some((m) => this.isOwnBot(connection, m.id))) installed = true;
      else if (activity.membersRemoved?.some((m) => this.isOwnBot(connection, m.id))) installed = false;
    }
    if (installed === undefined) return;

    try {
      const previous = this.bridge.db.getTeamsInstallations().get(teamsInstallationKey(connection.id, team.id));
      this.bridge.db.saveTeamsInstallation({
        teamId: team.id,
        connectionId: connection.id,
        tenantId: activity.channelData?.tenant?.id || activity.conversation?.tenantId,
        teamName: team.name,
        installed,
      });
      if (previous?.installed === installed) return;

      const label = team.name ? `"${team.name}"` : team.id;
      const bridges = this.bridge.db.getAllChannelMappings().filter((m) => m.teams.teamId === team.id).length;
      if (installed) {
        this.deliveryFailures.forEach((_f, channelId) => {
          if (this.bridge.db.findMappingByTeamsChannel(channelId)?.teams.teamId === team.id) this.deliveryFailures.delete(channelId);
        });
        console.log(
          `✅ InterBridge was added to the Teams team ${label} (connection "${connection.id}"). ` +
            (bridges ? `${bridges} bridge(s) use this team.` : 'No bridge uses this team yet; add one in the dashboard.')
        );
      } else {
        console.warn(
          `⚠️ InterBridge was removed from the Teams team ${label} (connection "${connection.id}").` +
            (bridges ? ` Its ${bridges} bridge(s) can't post there until the app is added back.` : '')
        );
      }
    } catch (err) {
      this.bridge.emit('error', err);
    }
  }

  /** Most recent failed post into a Teams channel, if the last attempt failed. */
  lastDeliveryFailure(channelId: string): TeamsDeliveryFailure | undefined {
    return this.deliveryFailures.get(channelId);
  }

  /**
   * Resolve the service URL to use when posting proactively to a Teams channel.
   */
  resolveServiceUrl(channelId: string, teamId?: string, connectionId?: string): string {
    const cached = this.serviceUrlMap.get(channelId);
    if (cached) return cached;

    const connection = this.connections.get(connectionId || this.defaultConnectionId);
    const stored = this.bridge.db.findTeamsServiceUrl(channelId, teamId, connection?.config.appTenantId);
    if (stored) {
      this.serviceUrlMap.set(channelId, stored);
      return stored;
    }

    const fallback = connection?.config.serviceUrl || this.fallbackServiceUrl;
    if (!this.warnedFallbackChannels.has(channelId)) {
      this.warnedFallbackChannels.add(channelId);
      console.warn(
        `⚠️ No Teams service URL recorded for ${channelId}; using TEAMS_SERVICE_URL fallback ${fallback}. ` +
          'Posts will use the stored URL once any activity arrives from this team.'
      );
    }
    return fallback;
  }

  /**
   * Send a message to a Teams channel originating from Slack.
   */
  async sendMessage(
    targetChannelId: string,
    message: NormalizedMessage,
    mapping: ChannelMapping,
    parentMessageId?: string
  ): Promise<{ messageId: string }> {
    const activity = this.buildActivity(message, mapping);

    if (parentMessageId) {
      activity.replyToId = parentMessageId;
    }

    // Proactive posts ignore replyToId in channels; the thread is addressed via the conversation id
    let sentMessageId = '';

    await this.proactive(targetChannelId, mapping, parentMessageId, async (turnContext) => {
      const response = await turnContext.sendActivity(activity);
      if (response?.id) {
        sentMessageId = response.id;
      }
    });

    return { messageId: sentMessageId || `${Date.now()}` };
  }

  /**
   * Update a message the bridge posted to Teams (the Slack original was edited).
   */
  async updateMessage(
    targetChannelId: string,
    targetMessageId: string,
    message: NormalizedMessage,
    mapping: ChannelMapping,
    threadRootId?: string,
    options?: { footer?: string }
  ): Promise<void> {
    const activity = this.buildActivity(message, mapping, options?.footer);
    activity.id = targetMessageId;

    await this.proactive(targetChannelId, mapping, threadRootId ?? targetMessageId, async (turnContext) => {
      await turnContext.updateActivity(activity);
    });
  }

  /**
   * Delete a message the bridge posted to Teams (the Slack original was deleted).
   */
  async deleteMessage(
    targetChannelId: string,
    targetMessageId: string,
    mapping: ChannelMapping,
    threadRootId?: string
  ): Promise<void> {
    await this.proactive(targetChannelId, mapping, threadRootId ?? targetMessageId, async (turnContext) => {
      await turnContext.deleteActivity(targetMessageId);
    });
  }

  /**
   * Build the outbound Teams activity for a relayed Slack message, per the mapping's display style.
   */
  private buildActivity(message: NormalizedMessage, mapping: ChannelMapping, footer?: string): Partial<Activity> {
    // Slack images arrive with a signed proxy URL Teams can load directly
    const images = (message.attachments || [])
      .filter((a) => a.displayUrl && isImageAttachment(a))
      .map((a) => ({ url: a.displayUrl!, name: a.name, contentType: a.contentType }));

    if (mapping.options.teamsFormatStyle === 'adaptive_card') {
      const cardPayload = MessageTranslator.formatForTeamsAdaptiveCard(message.sender, message.content, footer, images);
      return MessageFactory.attachment(CardFactory.adaptiveCard(cardPayload));
    }

    const activity = MessageFactory.text(MessageTranslator.formatForTeamsMarkdown(message.sender, message.content, footer));
    if (images.length) {
      activity.attachments = images.map((i) => ({ contentType: i.contentType, contentUrl: i.url, name: i.name }));
    }
    return activity;
  }

  /**
   * Download an inline Teams image using the bot's own Bot Framework token. Only Microsoft
   * attachment hosts are allowed, so the token is never sent to a URL supplied in a message.
   */
  async downloadAttachment(url: string, connectionId = this.defaultConnectionId): Promise<Buffer> {
    if (!isTeamsAttachmentHost(url)) throw new Error('refusing to send bot credentials to a non-Teams host');

    // Use the bot the message arrived through: other tenants' bots can't read this tenant's files
    const credentials = teamsCredentials(this.requireConnection(connectionId).config);
    const token = await credentials.getToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Teams attachment download failed: HTTP ${res.status}`);

    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_TRANSFER_BYTES) throw new Error('attachment is too large to transfer');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_TRANSFER_BYTES) throw new Error('attachment is too large to transfer');
    return body;
  }

  /**
   * Post a plain bridge notice as a reply in a thread (used for Slack reactions on Teams-authored messages).
   */
  async postNotice(
    targetChannelId: string,
    text: string,
    mapping: ChannelMapping,
    threadRootId: string
  ): Promise<{ messageId: string }> {
    let messageId = '';
    await this.proactive(targetChannelId, mapping, threadRootId, async (turnContext) => {
      const response = await turnContext.sendActivity(MessageFactory.text(text));
      messageId = response?.id || '';
    });
    if (!messageId) throw new Error('Teams did not return an id for the posted notice');
    return { messageId };
  }

  /**
   * Tell a Teams user something about their own message. Teams has no private messages in
   * channels, so this is a reply in the message's thread (the text names the sender).
   */
  async notifySender(
    channelId: string,
    _userId: string,
    text: string,
    mapping: ChannelMapping,
    threadRootId?: string
  ): Promise<{ messageId: string }> {
    if (!threadRootId) throw new Error('Teams sender notices need a thread to reply in');
    return this.postNotice(channelId, text, mapping, threadRootId);
  }

  /**
   * Replace the text of a notice posted with postNotice.
   */
  async updateNotice(
    targetChannelId: string,
    noticeId: string,
    text: string,
    mapping: ChannelMapping,
    threadRootId: string
  ): Promise<void> {
    const activity = MessageFactory.text(text);
    activity.id = noticeId;
    await this.proactive(targetChannelId, mapping, threadRootId, async (turnContext) => {
      await turnContext.updateActivity(activity);
    });
  }

  /**
   * Run a proactive call into a channel through the mapping's connection. Bot Framework passes an
   * error thrown inside the callback to onTurnError and then resolves normally, so it is captured
   * here and rethrown: a failed post must fail, or BridgeCore would record it as relayed. Teams'
   * "not installed" rejection becomes a TeamsNotInstalledError.
   */
  private async proactive(
    channelId: string,
    mapping: ChannelMapping,
    threadRootId: string | undefined,
    logic: (context: TurnContext) => Promise<void>
  ): Promise<void> {
    const connection = this.connectionFor(mapping);
    let failed = false;
    let failure: unknown;
    try {
      await connection.cloudAdapter.continueConversationAsync(
        connection.config.appId,
        this.conversationReference(channelId, mapping, threadRootId),
        async (context) => {
          try {
            await logic(context);
          } catch (err) {
            failed = true;
            failure = err;
          }
        }
      );
    } catch (err) {
      failed = true;
      failure = err;
    }

    if (!failed) {
      this.deliveryFailures.delete(channelId);
      return;
    }

    const notInstalled = isNotInConversationRoster(failure);
    const error = notInstalled
      ? new TeamsNotInstalledError(mapping.teams.teamName ? `"${mapping.teams.teamName}"` : mapping.teams.teamId, connection.id, {
          cause: failure,
        })
      : failure;
    this.deliveryFailures.set(channelId, {
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      notInstalled,
    });
    throw error;
  }

  /**
   * Conversation reference for proactive calls into a channel. Passing a thread root addresses
   * that thread (`<channelId>;messageid=<rootId>`), which Teams uses for per-message operations.
   */
  private conversationReference(
    channelId: string,
    mapping: ChannelMapping,
    threadRootId?: string
  ): Partial<ConversationReference> {
    return {
      channelId: 'msteams',
      serviceUrl: this.resolveServiceUrl(channelId, mapping.teams.teamId, this.connectionFor(mapping).id),
      conversation: {
        id: threadRootId ? `${channelId};messageid=${threadRootId}` : channelId,
        isGroup: true,
        conversationType: 'channel',
        name: '',
      },
    } as Partial<ConversationReference>;
  }

  /** Channel id of an activity, without any `;messageid=` thread suffix. */
  private channelIdOf(activity: Partial<Activity>): string {
    return activity.channelData?.channel?.id || (activity.conversation?.id || '').split(';')[0];
  }

  /**
   * Handle an incoming Bot Framework HTTP request for a connection. The connection's adapter
   * validates the Azure-issued JWT against that bot's App ID before any handler runs.
   */
  async processHttpRequest(req: unknown, res: unknown, connectionId = this.defaultConnectionId): Promise<void> {
    const connection = this.requireConnection(connectionId);
    await connection.cloudAdapter.process(req as any, res as any, (context) => this.runForConnection(context, connection.id));
  }

  /** Run the activity handlers for a turn that arrived on the given connection. */
  async runForConnection(context: TurnContext, connectionId: string): Promise<void> {
    context.turnState.set(CONNECTION_KEY, this.requireConnection(connectionId));
    await this.run(context);
  }
}

/**
 * CloudAdapter that answers webhook requests with a bad or missing token with a one-line warning
 * and a 401, instead of letting CloudAdapter.process log a full stack trace. The webhook is public,
 * so scanners and misconfigured bots hit it, and each one used to log ~10 lines.
 */
export class QuietAuthCloudAdapter extends CloudAdapter {
  constructor(
    auth: ConfigurationBotFrameworkAuthentication,
    private readonly connectionId: string
  ) {
    super(auth);
  }

  protected override async processActivity(
    authOrResult: string | AuthenticateRequestResult,
    activity: Activity,
    logic: (context: TurnContext) => Promise<void>
  ): Promise<InvokeResponse | undefined> {
    try {
      return await super.processActivity(authOrResult as any, activity, logic);
    } catch (err) {
      if (!(err instanceof AuthenticationError)) throw err;
      console.warn(
        `⚠️ Rejected a Teams webhook request on connection "${this.connectionId}" (${activity.type || 'no type'} ` +
          `activity, ${activity.serviceUrl || 'no service URL'}): ${err.message}`
      );
      return { status: StatusCodes.UNAUTHORIZED, body: err.message };
    }
  }
}

/**
 * Bot Framework credentials for a bot. Single-tenant bots get their token from their own tenant
 * rather than botframework.com.
 */
export function teamsCredentials(config: TeamsAdapterConfig): MicrosoftAppCredentials {
  return new MicrosoftAppCredentials(
    config.appId,
    config.appPassword || '',
    config.appType === 'SingleTenant' ? config.appTenantId : undefined
  );
}

/**
 * Extract user-visible file attachments from a Teams activity (links only; files aren't transferred).
 * Skips the `text/html` copy of the message body and cards.
 */
/** Hosts that serve Teams message attachments to bots (inline images). */
export function isTeamsAttachmentHost(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === 'https:' &&
      (hostname === 'smba.trafficmanager.net' ||
        ['asm.skype.com', 'teams.microsoft.com'].some((d) => hostname === d || hostname.endsWith(`.${d}`)))
    );
  } catch {
    return false;
  }
}

/**
 * Describe parts of a Teams message the bridge can't relay (cards, and attachment types it doesn't
 * recognise), for sender notices. Files, images, and the HTML body copy are handled elsewhere.
 */
export function teamsUnsupportedContent(activity: Partial<Activity>): string[] | undefined {
  const found = new Set<string>();
  for (const a of activity.attachments || []) {
    const type = a.contentType || '';
    if (type === 'text/html' || type === 'reference' || type === 'application/vnd.microsoft.teams.file.download.info') continue;
    if (type.startsWith('image/')) continue;
    if (type === 'application/vnd.microsoft.card.adaptive') found.add('Adaptive Cards');
    else if (type.startsWith('application/vnd.microsoft.card') || type.includes('.card.')) found.add('cards');
    else found.add(`${type || 'unknown'} attachments`);
  }
  return found.size ? [...found] : undefined;
}

export function teamsAttachments(
  activity: Partial<Activity>,
  download?: (url: string) => Promise<Buffer>
): Attachment[] | undefined {
  const files = (activity.attachments || []).flatMap((a, i): Attachment[] => {
    const type = a.contentType || '';
    if (type === 'text/html' || type.startsWith('application/vnd.microsoft.card')) return [];

    const id = `${activity.id || 'teams'}-att-${i}`;
    if (type === 'reference' || type === 'application/vnd.microsoft.teams.file.download.info') {
      const content = (a.content || {}) as { downloadUrl?: string; fileType?: string };
      return [
        {
          id,
          name: a.name || 'file',
          contentType: content.fileType || type,
          downloadUrl: content.downloadUrl || a.contentUrl,
          permalink: a.contentUrl,
        },
      ];
    }

    if (type.startsWith('image/')) {
      // Inline image URLs require the bot's credentials, so there's no link a Slack user could open;
      // the bridge downloads and re-uploads them instead (when the host is a known Teams host).
      const url = a.contentUrl;
      const fetchContent = url && download && isTeamsAttachmentHost(url) ? () => download(url) : undefined;
      // Keyed by URL so an edit re-delivering the same image is recognised (and not re-uploaded)
      return [{ id: url || id, name: a.name || 'image', contentType: type, downloadUrl: url, fetchContent }];
    }

    return [];
  });

  return files.length ? files : undefined;
}
