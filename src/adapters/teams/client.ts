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
  MessageFactory,
  TeamsActivityHandler,
  TurnContext,
} from 'botbuilder';
import { MicrosoftAppCredentials } from 'botframework-connector';
import { BridgeAdapter, BridgeCore } from '../../core/bridge.js';
import { MessageTranslator } from '../../core/translator.js';
import { MAX_TRANSFER_BYTES } from '../../core/media.js';
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
  serviceUrl?: string; // Default Azure Bot service URL: https://smba.trafficmanager.net/amer/
}

export class TeamsAdapter extends TeamsActivityHandler implements BridgeAdapter {
  public platform: Platform = 'teams';
  public adapter: CloudAdapter;
  private botAppId: string;
  /** In-memory cache in front of the persisted teams_conversations table */
  private serviceUrlMap = new Map<string, string>();
  private warnedFallbackChannels = new Set<string>();

  constructor(
    private config: TeamsAdapterConfig,
    private bridge: BridgeCore
  ) {
    super();

    this.botAppId = config.appId;
    if (this.botAppId) {
      this.bridge.dedup.registerBotId('teams', this.botAppId);
    }

    const botAuth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: config.appId,
      MicrosoftAppPassword: config.appPassword,
      MicrosoftAppTenantId: config.appTenantId,
      MicrosoftAppType: 'MultiTenant',
    });

    this.adapter = new CloudAdapter(botAuth);

    // Setup error handling
    // Report and swallow: rethrowing here returns a 500 to Bot Framework, which redelivers the activity.
    this.adapter.onTurnError = async (_context, error) => {
      const cause = error instanceof Error ? error : new Error(String(error));
      this.bridge.emit('error', new Error(`Teams Turn Error: ${cause.message}`, { cause }));
    };

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // 0. Remember the service URL from every inbound activity (messages, installs, channel
    // updates, reactions), so outbound posts reach the right region even before anyone speaks.
    this.onTurn(async (context: TurnContext, next) => {
      this.rememberServiceUrl(context.activity);
      await next();
    });

    // 1. Process all incoming channel messages (captured via Resource-Specific Consent)
    this.onMessage(async (context: TurnContext, next) => {
      const activity = context.activity;

      // Check if message is from the bot itself (Teams may send with or without '28:' prefix)
      const bareAppId = this.botAppId.replace(/^28:/, '');
      const senderId = activity.from?.id;
      if (senderId === bareAppId || senderId === `28:${bareAppId}`) {
        await next();
        return;
      }

      const text = activity.text?.trim() || '';
      const attachments = teamsAttachments(activity, (url) => this.downloadAttachment(url));
      if (!text && !attachments) {
        await next();
        return;
      }

      const teamsChannelId = activity.channelData?.channel?.id || activity.conversation?.id;
      const teamsTeamId = activity.channelData?.team?.id || '';

      const sender: UserIdentity = {
        platformId: activity.from?.id || activity.from?.aadObjectId || 'unknown',
        displayName: activity.from?.name || 'Teams User',
        platform: 'teams',
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
        timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
        rawEvent: activity,
      };

      await this.bridge.handleIncomingMessage(normalized);
      await next();
    });

    // 2. Edits and (soft) deletes of channel messages
    this.onTeamsMessageEditEvent(async (context: TurnContext, next) => {
      const activity = context.activity;
      const text = activity.text?.trim() || '';
      const attachments = teamsAttachments(activity, (url) => this.downloadAttachment(url));
      // Attachment-only edits are relayed too; BridgeCore drops them if syncFiles is off
      if (activity.id && (text || attachments)) {
        const teamsChannelId = this.channelIdOf(activity);
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
      if (activity.id) {
        await this.bridge.handleIncomingDelete({
          sourcePlatform: 'teams',
          sourceChannelId: this.channelIdOf(activity),
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
      if (!messageId || !teamsChannelId) return;

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
   * Resolve the service URL to use when posting proactively to a Teams channel.
   */
  resolveServiceUrl(channelId: string, teamId?: string): string {
    const cached = this.serviceUrlMap.get(channelId);
    if (cached) return cached;

    const stored = this.bridge.db.findTeamsServiceUrl(channelId, teamId);
    if (stored) {
      this.serviceUrlMap.set(channelId, stored);
      return stored;
    }

    const fallback = this.config.serviceUrl || 'https://smba.trafficmanager.net/amer/';
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
    const conversationReference = this.conversationReference(targetChannelId, mapping, parentMessageId);

    let sentMessageId = '';

    await this.adapter.continueConversationAsync(
      this.botAppId,
      conversationReference,
      async (turnContext) => {
        const response = await turnContext.sendActivity(activity);
        if (response?.id) {
          sentMessageId = response.id;
        }
      }
    );

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

    await this.adapter.continueConversationAsync(
      this.botAppId,
      this.conversationReference(targetChannelId, mapping, threadRootId ?? targetMessageId),
      async (turnContext) => {
        await turnContext.updateActivity(activity);
      }
    );
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
    await this.adapter.continueConversationAsync(
      this.botAppId,
      this.conversationReference(targetChannelId, mapping, threadRootId ?? targetMessageId),
      async (turnContext) => {
        await turnContext.deleteActivity(targetMessageId);
      }
    );
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
  async downloadAttachment(url: string): Promise<Buffer> {
    if (!isTeamsAttachmentHost(url)) throw new Error('refusing to send bot credentials to a non-Teams host');

    const credentials = new MicrosoftAppCredentials(this.config.appId, this.config.appPassword || '');
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
    await this.adapter.continueConversationAsync(
      this.botAppId,
      this.conversationReference(targetChannelId, mapping, threadRootId),
      async (turnContext) => {
        const response = await turnContext.sendActivity(MessageFactory.text(text));
        messageId = response?.id || '';
      }
    );
    if (!messageId) throw new Error('Teams did not return an id for the posted notice');
    return { messageId };
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
    await this.adapter.continueConversationAsync(
      this.botAppId,
      this.conversationReference(targetChannelId, mapping, threadRootId),
      async (turnContext) => {
        await turnContext.updateActivity(activity);
      }
    );
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
      serviceUrl: this.resolveServiceUrl(channelId, mapping.teams.teamId),
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
   * Handle incoming Bot Framework HTTP requests from Azure Bot Service.
   */
  async processHttpRequest(req: unknown, res: unknown): Promise<void> {
    await this.adapter.process(req as any, res as any, (context) => this.run(context));
  }
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
      (hostname === 'smba.trafficmanager.net' || hostname.endsWith('.asm.skype.com') || hostname.endsWith('.teams.microsoft.com'))
    );
  } catch {
    return false;
  }
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
