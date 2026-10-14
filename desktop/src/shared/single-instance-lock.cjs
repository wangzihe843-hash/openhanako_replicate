/**
 * Electron client single-instance guard.
 *
 * Electron's requestSingleInstanceLock() is scoped by userData, so HanaAgent sets
 * userData from HANA_HOME before requesting the lock. Production and dev homes
 * get different namespaces, while duplicate launches within the same home are
 * redirected to the first client.
 */
const { resolveDesktopIdentity, prepareDesktopUserData } = require("./user-data-identity.cjs");

function getUserDataAppName(hanakoHome, defaultHome) {
  return resolveDesktopIdentity(hanakoHome, defaultHome).appName;
}

function exitDuplicateClient(app) {
  if (typeof app.exit === "function") {
    app.exit(0);
    return;
  }
  app.quit();
}

function focusExistingWindow(win) {
  if (!win || win.isDestroyed?.()) return false;
  if (win.isMinimized?.()) win.restore?.();
  win.show?.();
  win.focus?.();
  return true;
}

function configureClientSingleInstance(app, opts) {
  const { hanakoHome, defaultHome, onSecondInstance } = opts;
  if (app.isReady?.()) {
    throw Object.assign(new Error("Desktop profile must be selected before Electron is ready."), {
      code: "HANA_DESKTOP_PROFILE_STARTUP",
    });
  }
  const selected = prepareDesktopUserData({
    hanakoHome, defaultHome, appData: app.getPath("appData"),
    argv: opts.argv, env: opts.env, fsImpl: opts.fsImpl,
  });
  app.setPath("userData", selected.userData);
  if (selected.sessionData) app.setPath("sessionData", selected.sessionData);

  const gotLock = app.requestSingleInstanceLock({ hanakoHome });
  if (!gotLock) {
    exitDuplicateClient(app);
    return false;
  }

  app.on("second-instance", () => {
    onSecondInstance?.();
  });
  return true;
}

module.exports = {
  configureClientSingleInstance,
  focusExistingWindow,
  getUserDataAppName,
};
