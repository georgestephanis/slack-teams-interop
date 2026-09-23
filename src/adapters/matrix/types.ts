/**
 * Matrix.org Normalized Event Schema Adapter
 * Provides canonical Matrix event models (m.room.message, m.reaction, m.relates_to)
 * allowing the bridge to seamlessly interoperate with Matrix homeservers (Synapse, Conduit, Dendrite).
 */

import { NormalizedMessage, NormalizedReaction } from '../../core/types.js';

export interface MatrixEventContent {
  msgtype: 'm.text' | 'm.image' | 'm.file' | 'm.notice';
  body: string;
  format?: 'org.matrix.custom.html';
  formatted_body?: string;
  'm.relates_to'?: {
    rel_type?: 'm.thread' | 'm.annotation';
    event_id?: string;
    key?: string; // For reactions
    is_falling_back?: boolean;
  };
}

export interface MatrixRoomEvent {
  event_id: string;
  room_id: string;
  sender: string;
  origin_server_ts: number;
  type: 'm.room.message' | 'm.reaction';
  content: MatrixEventContent;
}

export class MatrixEventConverter {
  /**
   * Convert a NormalizedMessage to a standard Matrix m.room.message event
   */
  static toMatrixEvent(roomId: string, message: NormalizedMessage): MatrixRoomEvent {
    const content: MatrixEventContent = {
      msgtype: 'm.text',
      body: `[${message.sourcePlatform.toUpperCase()}] ${message.sender.displayName}: ${message.content}`,
      format: 'org.matrix.custom.html',
      formatted_body: `<b>[${message.sourcePlatform.toUpperCase()}] ${message.sender.displayName}</b>: ${message.content}`,
    };

    if (message.sourceParentId) {
      content['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id: message.sourceParentId,
      };
    }

    return {
      event_id: `$${message.id}`,
      room_id: roomId,
      sender: `@${message.sender.platformId}:${message.sourcePlatform}.bridge`,
      origin_server_ts: message.timestamp.getTime(),
      type: 'm.room.message',
      content,
    };
  }

  /**
   * Convert a Matrix m.room.message event to a NormalizedMessage
   */
  static fromMatrixEvent(event: MatrixRoomEvent): NormalizedMessage {
    const parentId = event.content['m.relates_to']?.rel_type === 'm.thread'
      ? event.content['m.relates_to']?.event_id
      : undefined;

    return {
      id: event.event_id,
      sourcePlatform: 'matrix',
      sourceChannelId: event.room_id,
      sourceMessageId: event.event_id,
      sourceParentId: parentId,
      sender: {
        platformId: event.sender,
        displayName: event.sender.split(':')[0].replace('@', ''),
        platform: 'matrix',
      },
      content: event.content.body,
      timestamp: new Date(event.origin_server_ts),
      rawEvent: event,
    };
  }
}
