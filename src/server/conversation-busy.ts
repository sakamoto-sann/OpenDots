export class ConversationBusyError extends Error {
  constructor() {
    super('This conversation is busy. Retry shortly.');
  }
}
