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
  MessageFactory,
  TeamsActivityHandler,
  TurnContext,
} from 'botbuilder';
import { BridgeAdapter, BridgeCore } from '../../core/bridge.js';
import { MessageTranslator } from '../../core/translator.js';
import {
  ChannelMapping,
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
      if (!text) {
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
        timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
        rawEvent: activity,
      };

      await this.bridge.handleIncomingMessage(normalized);
      await next();
    });

    // 2. Reactions
    this.onReactionsAdded(async (context: TurnContext, next) => {
      const activity = context.activity;
      const teamsChannelId = activity.channelData?.channel?.id || activity.conversation?.id;

      if (activity.reactionsAdded) {
        for (const r of activity.reactionsAdded) {
          const reaction: NormalizedReaction = {
            id: `teams-reaction-${activity.replyToId || activity.id}-${r.type}`,
            sourcePlatform: 'teams',
            sourceChannelId: teamsChannelId,
            sourceMessageId: activity.replyToId || activity.id || '',
            sender: {
              platformId: activity.from?.id || 'unknown',
              displayName: activity.from?.name || 'Teams User',
              platform: 'teams',
            },
            emoji: r.type,
            action: 'add',
          };
          await this.bridge.handleIncomingReaction(reaction);
        }
      }

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
    let activity: Partial<Activity>;

    if (mapping.options.teamsFormatStyle === 'adaptive_card') {
      const cardPayload = MessageTranslator.formatForTeamsAdaptiveCard(message.sender, message.content);
      activity = MessageFactory.attachment(CardFactory.adaptiveCard(cardPayload));
    } else {
      const formattedText = MessageTranslator.formatForTeamsMarkdown(message.sender, message.content);
      activity = MessageFactory.text(formattedText);
    }

    if (parentMessageId) {
      activity.replyToId = parentMessageId;
    }

    const serviceUrl = this.resolveServiceUrl(targetChannelId, mapping.teams.teamId);

    // Construct conversation reference for proactive channel posting
    const conversationReference = {
      channelId: 'msteams',
      serviceUrl,
      conversation: {
        id: targetChannelId,
        isGroup: true,
        conversationType: 'channel',
        name: '',
      },
    };

    let sentMessageId = '';

    await this.adapter.continueConversationAsync(
      this.botAppId,
      conversationReference as any,
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
   * Handle incoming Bot Framework HTTP requests from Azure Bot Service.
   */
  async processHttpRequest(req: unknown, res: unknown): Promise<void> {
    await this.adapter.process(req as any, res as any, (context) => this.run(context));
  }
}
