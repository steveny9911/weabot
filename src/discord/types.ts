/** Discord poll payloads: https://discord.com/developers/docs/resources/poll */

export interface PollMedia {
  text: string;
  emoji?: { id?: string; name?: string }; // Future: emoji support
}

export interface PollAnswer {
  poll_media: PollMedia;
}

export interface PollPayload {
  question: { text: string };
  answers: PollAnswer[];
  duration: number; // Hours
  allow_multiselect: boolean;
}

export interface CreatePollMessagePayload {
  poll: PollPayload;
}
