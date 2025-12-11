/**
 * Discord API Type Definitions
 *
 * These interfaces mirror the Discord REST API payload structures.
 * See: https://discord.com/developers/docs/resources/poll
 */

/** Represents the media content within a poll option */
export interface PollMedia {
  text: string;
  emoji?: { id?: string; name?: string }; // Future: emoji support
}

/** Represents a single answer option in a poll */
export interface PollAnswer {
  poll_media: PollMedia;
}

/** The poll object sent to Discord's Create Message endpoint */
export interface PollPayload {
  question: { text: string };
  answers: PollAnswer[];
  duration: number; // Hours
  allow_multiselect: boolean;
}

/** The full message body for creating a message with a poll */
export interface CreatePollMessagePayload {
  poll: PollPayload;
}
