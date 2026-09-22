'use strict';
// Thrown when the screen has nothing to show yet because a source has not been set up (no calendar
// links added, no Todoist token saved). The server adds a plain-language hint pointing at the dashboard.
class SetupNeeded extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupNeeded';
  }
}

module.exports = { SetupNeeded };
