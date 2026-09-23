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
  private serviceUrlMap = new Map<string, string>();

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
    this.adapter.onTurnError = async (context, error) => {
      this.bridge.emit('error', new Error(`Teams Turn Error: ${error.message}`));
    };

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // 1. Process all incoming channel messages (captured via Resource-Specific Consent)
    this.onMessage(async (context: TurnContext, next) => {
      const activity = context.activity;

      // Cache serviceUrl for outbound push messages to this conversation
      if (activity.serviceUrl && activity.conversation?.id) {
        this.serviceUrlMap.set(activity.conversation.id, activity.serviceUrl);
        const channelId = activity.channelData?.channel?.id;
        if (channelId) {
          this.serviceUrlMap.set(channelId, activity.serviceUrl);
        }
      }

      // Check if message is from the bot itself (Teams uses `28:<appId>` for bot senders)
      if (activity.from?.id === this.botAppId || activity.from?.id === `28:${this.botAppId}`) {
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

    // Determine target service URL (cached or default Americas/Global)
    const serviceUrl =
      this.serviceUrlMap.get(targetChannelId) ||
      this.config.serviceUrl ||
      'https://smba.trafficmanager.net/amer/';

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
