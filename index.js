#!/usr/bin/env node
"use strict";

const readline = require("readline");
const util = require("util");
const Steam = require("steam-user");
const TOTP = require("steam-totp");
const fs = require("fs");
const dotenv = require("dotenv");

console.log(`Documentation: https://github.com/tacheometry/steam-hour-farmer`);

const MIN_REQUEST_TIME = 60 * 1000;
const LOG_ON_INTERVAL = 10 * 60 * 1000;
const REFRESH_GAMES_INTERVAL = 5 * 60 * 1000;

const readlineInterface = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const consoleQuestion = util.promisify(readlineInterface.question).bind(readlineInterface);

const envContent = fs.readFileSync(".env", "utf8");
const lines = envContent.split("\n");
const accounts = [];
let currentAccountLines = [];

lines.forEach((line) => {
  const trimmed = line.trim();
  if (trimmed === "[STEAM_ACCOUNT]") {
    if (currentAccountLines.length > 0) {
      const accountEnv = currentAccountLines.join("\n");
      const accountConfig = dotenv.parse(accountEnv);
      accounts.push(accountConfig);
      currentAccountLines = [];
    }
  } else {
    currentAccountLines.push(line);
  }
});

if (currentAccountLines.length > 0) {
  const accountEnv = currentAccountLines.join("\n");
  const accountConfig = dotenv.parse(accountEnv);
  accounts.push(accountConfig);
}

const processedAccounts = accounts
  .map((accountConfig) => {
    const account = {
      ACCOUNT_NAME: accountConfig.ACCOUNT_NAME,
      PASSWORD: accountConfig.PASSWORD,
      SHARED_SECRET: accountConfig.SHARED_SECRET || "",
      GAMES: accountConfig.GAMES
        ? accountConfig.GAMES.split(",").map((game) => {
            const asNumber = parseInt(game);
            return isNaN(asNumber) ? game : asNumber;
          })
        : [],
      PERSONA: accountConfig.PERSONA ? parseInt(accountConfig.PERSONA) : undefined,
    };

    if (!account.ACCOUNT_NAME || !account.PASSWORD || account.GAMES.length === 0) {
      console.error(
        `Account missing required fields (ACCOUNT_NAME, PASSWORD, or GAMES) for "${account.ACCOUNT_NAME || "unknown"}". Skipping this account.`
      );
      return null;
    }

    if (account.GAMES.length === 0) {
      console.warn(`No games to play for account "${account.ACCOUNT_NAME}". Maybe this is a mistake?`);
    }

    return account;
  })
  .filter((account) => account !== null);

if (processedAccounts.length === 0) {
  console.error("No valid accounts found in .env file.");
  process.exit(1);
}

const clients = processedAccounts.map((account) => ({
  account,
  user: new Steam({
    machineIdType: Steam.EMachineIDType.PersistentRandom,
    dataDirectory: `SteamData/${account.ACCOUNT_NAME}`,
    renewRefreshTokens: true,
  }),
  authenticated: false,
  playingOnOtherSession: false,
  currentNotification: "",
  lastGameRefreshTime: new Date(0),
  lastLogOnTime: new Date(0),
  onlyLogInAfter: new Date(0),
}));

const logOn = (client) => {
  if (client.authenticated) return;
  if (Date.now() - client.lastLogOnTime <= MIN_REQUEST_TIME) return;
  if (Date.now() < client.onlyLogInAfter) return;
  console.log(`Logging in for account "${client.account.ACCOUNT_NAME}"...`);
  client.user.logOn({
    accountName: client.account.ACCOUNT_NAME,
    password: client.account.PASSWORD,
    machineName: "steam-hour-farmer",
    clientOS: Steam.EOSType.Windows10,
    twoFactorCode: client.account.SHARED_SECRET
      ? TOTP.generateAuthCode(client.account.SHARED_SECRET)
      : undefined,
    autoRelogin: true,
  });
  client.lastLogOnTime = Date.now();
};

const refreshGames = (client) => {
  if (!client.authenticated) return;
  let notification;
  if (client.playingOnOtherSession) {
    notification = `Farming is paused for account "${client.account.ACCOUNT_NAME}".`;
  } else {
    if (Date.now() - client.lastGameRefreshTime <= MIN_REQUEST_TIME) return;
    client.user.gamesPlayed(client.account.GAMES);
    notification = `Farming for account "${client.account.ACCOUNT_NAME}"...`;
    client.lastGameRefreshTime = Date.now();
  }
  if (client.currentNotification !== notification) {
    client.currentNotification = notification;
    console.log(notification);
  }
};

clients.forEach((client) => {
  client.user.on("steamGuard", async (domain, callback) => {
    if (client.account.SHARED_SECRET) {
      return callback(TOTP.generateAuthCode(client.account.SHARED_SECRET));
    }
    const manualCode = await consoleQuestion(
      `Enter Steam Guard code for account "${client.account.ACCOUNT_NAME}"` +
        (domain ? ` for email at ${domain}` : "") +
        ": "
    );
    callback(manualCode);
  });

  client.user.on("playingState", (blocked, app) => {
    client.playingOnOtherSession = blocked;
    refreshGames(client);
  });

  client.user.on("loggedOn", () => {
    client.authenticated = true;
    console.log(
      `Successfully logged in to Steam with ID ${client.user.steamID} for account "${client.account.ACCOUNT_NAME}"`
    );
    if (client.account.PERSONA !== undefined) {
      client.user.setPersona(client.account.PERSONA);
    }
    refreshGames(client);
  });

  client.user.on("error", (e) => {
    switch (e.eresult) {
      case Steam.EResult.LoggedInElsewhere: {
        client.authenticated = false;
        console.log(
          `Got kicked by other Steam session for account "${client.account.ACCOUNT_NAME}". Will log in shortly...`
        );
        logOn(client);
        break;
      }
      case Steam.EResult.RateLimitExceeded: {
        client.authenticated = false;
        client.onlyLogInAfter = Date.now() + 31 * 60 * 1000;
        console.log(
          `Got rate limited by Steam for account "${client.account.ACCOUNT_NAME}". Will try logging in again in 30 minutes.`
        );
        break;
      }
      default: {
        console.error(
          `Got an error from Steam for account "${client.account.ACCOUNT_NAME}": "${e.message}". Continuing with other accounts.`
        );
      }
    }
  });
});

clients.forEach((client) => logOn(client));
setInterval(() => {clients.forEach((client) => logOn(client));}, LOG_ON_INTERVAL);
setInterval(() => {clients.forEach((client) => refreshGames(client));}, REFRESH_GAMES_INTERVAL);