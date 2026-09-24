import { describe, expect, it } from 'vitest';
import { MessageTranslator } from '../src/core/translator.js';

describe('MessageTranslator', () => {
  describe('Slack to Teams translation', () => {
    it('converts bold from Slack *bold* to Teams **bold**', () => {
      const input = 'This is *very important* information';
      const output = MessageTranslator.slackToTeams(input);
      expect(output).toBe('This is **very important** information');
    });

    it('converts italic from Slack _italic_ to Teams *italic*', () => {
      const input = 'This is _subtle_ text';
      const output = MessageTranslator.slackToTeams(input);
      expect(output).toBe('This is *subtle* text');
    });

    it('converts strikethrough from Slack ~strike~ to Teams ~~strike~~', () => {
      const input = 'This is ~outdated~ text';
      const output = MessageTranslator.slackToTeams(input);
      expect(output).toBe('This is ~~outdated~~ text');
    });

    it('converts Slack links to Markdown links', () => {
      const withText = 'Check <https://example.com|our website>';
      expect(MessageTranslator.slackToTeams(withText)).toBe('Check [our website](https://example.com)');

      const bareUrl = 'Visit <https://example.com>';
      expect(MessageTranslator.slackToTeams(bareUrl)).toBe('Visit [https://example.com](https://example.com)');
    });

    it('converts Slack channel and broadcast mentions', () => {
      expect(MessageTranslator.slackToTeams('<#C123|announcements>')).toBe('#announcements');
      expect(MessageTranslator.slackToTeams('<!here> please review')).toBe('@here please review');
      expect(MessageTranslator.slackToTeams('<!channel> heads up')).toBe('@channel heads up');
    });

    it('preserves code blocks and inline code without altering inner syntax', () => {
      const codeBlock = 'Here is code:\n```\nconst x = *not_bold*;\n```';
      const output = MessageTranslator.slackToTeams(codeBlock);
      expect(output).toContain('const x = *not_bold*;');

      const inlineCode = 'Look at `*not bold*` here';
      expect(MessageTranslator.slackToTeams(inlineCode)).toBe('Look at `*not bold*` here');
    });
  });

  describe('Teams to Slack translation', () => {
    it('converts bold from Teams **bold** to Slack *bold*', () => {
      const input = 'This is **very important** information';
      expect(MessageTranslator.teamsToSlack(input)).toBe('This is *very important* information');
    });

    it('converts italic from Teams *italic* to Slack _italic*', () => {
      const input = 'This is *italic* note';
      expect(MessageTranslator.teamsToSlack(input)).toBe('This is _italic_ note');
    });

    it('converts strikethrough from Teams ~~strike~~ to Slack ~strike~', () => {
      const input = 'This is ~~deleted~~ text';
      expect(MessageTranslator.teamsToSlack(input)).toBe('This is ~deleted~ text');
    });

    it('converts Teams markdown links to Slack links', () => {
      const input = 'Check [our docs](https://docs.example.com)';
      expect(MessageTranslator.teamsToSlack(input)).toBe('Check <https://docs.example.com|our docs>');
    });

    it('parses Teams HTML tags into Slack mrkdwn', () => {
      const html = '<p>Hello <b>world</b> and <a href="https://test.com">click here</a></p>';
      const output = MessageTranslator.teamsToSlack(html);
      expect(output).toContain('Hello *world* and <https://test.com|click here>');
    });
  });

  describe('Adaptive Card generation', () => {
    it('creates a valid adaptive card structure', () => {
      const sender = {
        platformId: 'U12345',
        displayName: 'Jane Doe',
        avatarUrl: 'https://example.com/jane.png',
        platform: 'slack' as const,
      };
      const card = MessageTranslator.formatForTeamsAdaptiveCard(sender, 'Hello from Slack!') as any;

      expect(card.type).toBe('AdaptiveCard');
      expect(card.version).toBe('1.4');
      expect(card.body[0].type).toBe('ColumnSet');
      expect(card.body[1].text).toBe('Hello from Slack!');
    });
  });

  describe('Reaction mapping', () => {
    it('maps Teams reaction types to Slack emoji names', () => {
      expect(MessageTranslator.teamsReactionToSlack('like')).toBe('+1');
      expect(MessageTranslator.teamsReactionToSlack('laugh')).toBe('laughing');
      expect(MessageTranslator.teamsReactionToSlack('Surprised')).toBe('open_mouth');
      expect(MessageTranslator.teamsReactionToSlack('unknown')).toBeUndefined();
    });

    it('maps Slack emoji names to Teams reaction types', () => {
      expect(MessageTranslator.slackReactionToTeams('+1')).toBe('like');
      expect(MessageTranslator.slackReactionToTeams('thumbsup')).toBe('like');
      expect(MessageTranslator.slackReactionToTeams(':heart:')).toBe('heart');
      expect(MessageTranslator.slackReactionToTeams('joy')).toBe('laugh');
      expect(MessageTranslator.slackReactionToTeams('unknown_emoji')).toBeUndefined();
    });
  });

  describe('Reaction rendering', () => {
    it('renders Slack emoji names as glyphs, falling back to :name:', () => {
      expect(MessageTranslator.slackEmojiToGlyph('+1')).toBe('👍');
      expect(MessageTranslator.slackEmojiToGlyph(':tada:')).toBe('🎉');
      expect(MessageTranslator.slackEmojiToGlyph('wave::skin-tone-3')).toBe('👋');
      expect(MessageTranslator.slackEmojiToGlyph('partyparrot')).toBe(':partyparrot:');
    });

    it('formats footers and notices', () => {
      const groups = [
        { emoji: '+1', users: ['Jane', 'Omar', 'Li', 'Sam'] },
        { emoji: 'tada', users: ['Priya'] },
      ];
      expect(MessageTranslator.formatReactionFooter(groups)).toBe('👍 4 · 🎉 1 — reactions from Slack');
      expect(MessageTranslator.formatReactionFooter([])).toBe('');
      expect(MessageTranslator.formatReactionNotice(groups)).toBe('_Reactions from Slack:_ 👍 Jane, Omar, Li +1 · 🎉 Priya');
    });

    it('adds a subtle footer block to adaptive cards', () => {
      const card = MessageTranslator.formatForTeamsAdaptiveCard(
        { platformId: 'U1', displayName: 'Jane', platform: 'slack' },
        'hi',
        '👍 1 — reactions from Slack'
      ) as any;
      expect(card.body[2]).toMatchObject({ type: 'TextBlock', text: '👍 1 — reactions from Slack', isSubtle: true });
    });
  });
});
