/**
 * Markdown Dialect and Rich Text Translator
 * Handles bidirectional conversion between Slack mrkdwn and Teams CommonMark/HTML.
 */

import { UserIdentity } from './types.js';

/**
 * Teams reaction types mapped to Slack emoji names.
 * https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/subscribe-to-conversation-events#message-reaction-events
 */
const TEAMS_TO_SLACK_REACTIONS: Record<string, string> = {
  like: '+1',
  heart: 'heart',
  laugh: 'laughing',
  surprised: 'open_mouth',
  sad: 'cry',
  angry: 'angry',
};

const SLACK_TO_TEAMS_REACTIONS: Record<string, string> = {
  '+1': 'like',
  thumbsup: 'like',
  heart: 'heart',
  laughing: 'laugh',
  joy: 'laugh',
  open_mouth: 'surprised',
  astonished: 'surprised',
  cry: 'sad',
  sob: 'sad',
  angry: 'angry',
  rage: 'angry',
};

export class MessageTranslator {
  /**
   * Convert a Teams reaction type into a Slack emoji name, or undefined if there is no equivalent.
   */
  static teamsReactionToSlack(reactionType: string): string | undefined {
    return TEAMS_TO_SLACK_REACTIONS[reactionType.toLowerCase()];
  }

  /**
   * Convert a Slack emoji name into a Teams reaction type, or undefined if there is no equivalent.
   */
  static slackReactionToTeams(emojiName: string): string | undefined {
    return SLACK_TO_TEAMS_REACTIONS[emojiName.toLowerCase().replace(/^:|:$/g, '')];
  }

  /**
   * Convert Slack mrkdwn into standard Teams Markdown / HTML.
   */
  static slackToTeams(mrkdwn: string, userMap?: Map<string, string>): string {
    if (!mrkdwn) return '';

    let text = mrkdwn;

    // 1. Preserve code blocks and inline code to prevent formatting inside code
    const codeBlocks: string[] = [];
    text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    const inlineCodes: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return `__INLINE_CODE_${inlineCodes.length - 1}__`;
    });

    // 2. Convert Slack links: <http://url|Text> -> [Text](http://url) and <http://url> -> [http://url](http://url)
    text = text.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '[$2]($1)');
    text = text.replace(/<(https?:\/\/[^>]+)>/g, '[$1]($1)');

    // 3. Convert Slack channel mentions: <#C123456|general> -> #general, <#C123456> -> #channel
    text = text.replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2');
    text = text.replace(/<#([A-Z0-9]+)>/g, '#channel');

    // 4. Convert Slack user mentions: <@U123456>
    text = text.replace(/<@([A-Z0-9]+)>/g, (_, userId) => {
      const name = userMap?.get(userId) || userId;
      return `@${name}`;
    });

    // 5. Convert broadcast mentions: <!here>, <!channel>, <!everyone>
    text = text.replace(/<!here>/g, '@here');
    text = text.replace(/<!channel>/g, '@channel');
    text = text.replace(/<!everyone>/g, '@everyone');

    // 6. Convert Strikethrough: ~text~ -> ~~text~~
    // Must not match tildes in URLs or already escaped text
    text = text.replace(/(^|\s)~([^~\n]+)~(\s|$|[.,!?])/g, '$1~~$2~~$3');

    // 7. Convert Bold: Slack *bold* -> Teams **bold**
    // Match *word* but not list bullets (* item) or math
    text = text.replace(/(^|[^\w*])\*([^*\n]+)\*([^\w*]|$)/g, '$1**$2**$3');

    // 8. Convert Italic: Slack _italic_ -> Teams *italic*
    text = text.replace(/(^|[^\w_])_([^_\n]+)_([^\w_]|$)/g, '$1*$2*$3');

    // Restore inline codes
    inlineCodes.forEach((code, index) => {
      text = text.replace(`__INLINE_CODE_${index}__`, `\`${code}\``);
    });

    // Restore code blocks
    codeBlocks.forEach((code, index) => {
      text = text.replace(`__CODE_BLOCK_${index}__`, `\`\`\`${code}\`\`\``);
    });

    return text.trim();
  }

  /**
   * Convert Teams message text/HTML into Slack mrkdwn.
   */
  static teamsToSlack(teamsText: string): string {
    if (!teamsText) return '';

    let text = teamsText;

    // Handle HTML payloads from Teams (Teams often sends HTML tags)
    if (/<[a-z][\s\S]*>/i.test(text)) {
      text = this.htmlToSlackMrkdwn(text);
    }

    // 1. Preserve code blocks and inline code
    const codeBlocks: string[] = [];
    text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    const inlineCodes: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return `__INLINE_CODE_${inlineCodes.length - 1}__`;
    });

    // 2. Convert Teams markdown links: [Text](http://url) -> <http://url|Text>
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>');

    // 3. Convert Teams bold with placeholder to avoid colliding with italic
    const boldBlocks: string[] = [];
    text = text.replace(/(^|[^\w*])\*\*([^*\n]+)\*\*([^\w*]|$)/g, (_, before, bold, after) => {
      boldBlocks.push(bold);
      return `${before}__BOLD_${boldBlocks.length - 1}__${after}`;
    });

    // 4. Convert Teams italic: *text* -> _text_
    text = text.replace(/(^|[^\w*])\*([^*\n]+)\*([^\w*]|$)/g, '$1_$2_$3');

    // 5. Restore bold as Slack *bold*
    boldBlocks.forEach((bold, index) => {
      text = text.replace(`__BOLD_${index}__`, `*${bold}*`);
    });

    // 6. Convert Teams strikethrough: ~~text~~ -> ~text~
    text = text.replace(/(^|\s)~~([^~\n]+)~~(\s|$|[.,!?])/g, '$1~$2~$3');

    // Restore inline codes
    inlineCodes.forEach((code, index) => {
      text = text.replace(`__INLINE_CODE_${index}__`, `\`${code}\``);
    });

    // Restore code blocks
    codeBlocks.forEach((code, index) => {
      text = text.replace(`__CODE_BLOCK_${index}__`, `\`\`\`${code}\`\`\``);
    });

    return text.trim();
  }

  /**
   * Helper to strip and translate common Teams HTML tags to Markdown / Slack mrkdwn.
   */
  private static htmlToSlackMrkdwn(html: string): string {
    let out = html;

    // Line breaks & paragraphs
    out = out.replace(/<br\s*\/?>/gi, '\n');
    out = out.replace(/<\/p>\s*<p>/gi, '\n\n');
    out = out.replace(/<p>/gi, '');
    out = out.replace(/<\/p>/gi, '\n');

    // Links: convert to Markdown [Text](url) first so it is not stripped
    out = out.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

    // Bold
    out = out.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**');

    // Italic
    out = out.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*');

    // Strikethrough
    out = out.replace(/<(s|del|strike)>([\s\S]*?)<\/\1>/gi, '~~$2~~');

    // Mentions: <at id="0">User Name</at>
    out = out.replace(/<at[^>]*>([\s\S]*?)<\/at>/gi, '@$1');

    // Code blocks & inline code
    out = out.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, '```$1```');
    out = out.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');

    // Safely remove any remaining HTML tags (like <span>, <div>)
    out = out.replace(/<(?!\/?[a-z0-9]+:[a-z0-9]+)[^>]+>/gi, '');

    // Decode standard HTML entities
    out = out
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');

    return out;
  }

  /**
   * Format message for display in Teams using clean markdown header.
   */
  static formatForTeamsMarkdown(sender: UserIdentity, content: string): string {
    const cleanContent = this.slackToTeams(content);
    return `**[Slack] ${sender.displayName}**\n\n${cleanContent}`;
  }

  /**
   * Generate an Adaptive Card payload for Teams display.
   */
  static formatForTeamsAdaptiveCard(sender: UserIdentity, content: string): object {
    const cleanContent = this.slackToTeams(content);

    return {
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'ColumnSet',
          columns: [
            {
              type: 'Column',
              width: 'auto',
              items: [
                {
                  type: 'Image',
                  url: sender.avatarUrl || 'https://raw.githubusercontent.com/microsoft/botframework-sdk/master/icon.png',
                  size: 'Small',
                  style: 'Person'
                }
              ]
            },
            {
              type: 'Column',
              width: 'stretch',
              items: [
                {
                  type: 'TextBlock',
                  text: sender.displayName,
                  weight: 'Bolder',
                  wrap: true
                },
                {
                  type: 'TextBlock',
                  spacing: 'None',
                  text: 'via Slack',
                  isSubtle: true,
                  size: 'Small'
                }
              ]
            }
          ]
        },
        {
          type: 'TextBlock',
          text: cleanContent,
          wrap: true
        }
      ]
    };
  }
}
