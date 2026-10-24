"use strict";

// Fork build policy. Preferences, old invite records and environment feed
// overrides cannot enable online updates. A future release service needs a
// separately reviewed source change; offline seed/rollback paths do not use it.
module.exports = Object.freeze({
  onlineUpdatesEnabled: false,
  disabledMessage: "Online updates are unavailable in this fork. Upgrade using this project's instructions.",
});
