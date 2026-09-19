const axios = require("axios");
const crypto = require("crypto");

const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://synapse:8008";

const OIDC_ISSUER = process.env.OIDC_ISSUER || "https://auth.41chan.net/";
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID;
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI;

const MatrixProvider = {
  name: "matrix",
  async login({ username, password }) {
    if (!username || !password) {
      const e = new Error("username and password required");
      e.status = 400;
      throw e;
    }
    let resp;
    try {
      resp = await axios.post(
        `${SYNAPSE_URL}/_matrix/client/v3/login`,
        {
          type: "m.login.password",
          identifier: { type: "m.id.user", user: username },
          password: password,
          initial_device_display_name: "Fourier",
        },
        { validateStatus: () => true }
      );
    } catch (err) {
      const e = new Error("could not reach homeserver");
      e.status = 502;
      throw e;
    }
    if (resp.status !== 200) {
      const e = new Error((resp.data && resp.data.error) || "login failed");
      e.status = 401;
      throw e;
    }
    return {
      matrixUserId: resp.data.user_id,
      matrixToken: resp.data.access_token,
      deviceId: resp.data.device_id,
    };
  },
};

let _discovery = null;
async function discover() {
  if (_discovery) return _discovery;
  const url = OIDC_ISSUER.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const resp = await axios.get(url, { validateStatus: () => true });
  if (resp.status !== 200) {
    const e = new Error("OIDC discovery failed");
    e.status = 502;
    throw e;
  }
  _discovery = resp.data;
  return _discovery;
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const OidcProvider = {
  name: "oidc",

  async authUrl() {
    const disc = await discover();
    const state = base64url(crypto.randomBytes(24));
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(
      crypto.createHash("sha256").update(codeVerifier).digest()
    );
    const params = new URLSearchParams({
      response_type: "code",
      client_id: OIDC_CLIENT_ID,
      redirect_uri: OIDC_REDIRECT_URI,
      scope: "openid urn:matrix:org.matrix.msc2967.client:api:*",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return {
      url: `${disc.authorization_endpoint}?${params.toString()}`,
      state,
      codeVerifier,
    };
  },

  async exchange({ code, codeVerifier }) {
    const disc = await discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: OIDC_REDIRECT_URI,
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
      code_verifier: codeVerifier,
    });
    const tokResp = await axios.post(disc.token_endpoint, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      validateStatus: () => true,
    });
    if (tokResp.status !== 200) {
      const e = new Error(
        (tokResp.data && (tokResp.data.error_description || tokResp.data.error)) ||
          "token exchange failed"
      );
      e.status = 401;
      throw e;
    }
    const matrixToken = tokResp.data.access_token;
    // The REFRESH TOKEN and the access token's life. Dropped until 2026-09-19,
    // which left every 24-hour session holding a five-minute token.
    const refreshToken = tokResp.data.refresh_token || null;
    const expiresIn = Number(tokResp.data.expires_in) || null;

    const who = await axios.get(
      `${SYNAPSE_URL}/_matrix/client/v3/account/whoami`,
      {
        headers: { Authorization: `Bearer ${matrixToken}` },
        validateStatus: () => true,
      }
    );
    if (who.status !== 200) {
      const e = new Error("could not resolve Matrix identity from token");
      e.status = 401;
      throw e;
    }
    return {
      matrixUserId: who.data.user_id,
      matrixToken,
      refreshToken,
      expiresIn,
      deviceId: who.data.device_id,
    };
  },

  /**
   * One refresh_token grant against MAS. Returns MAS's token response
   * verbatim (access_token, refresh_token -- rotated -- and expires_in).
   * Throws on anything but 200; the caller decides what a failed refresh
   * means for the session.
   */
  async refresh(refreshToken) {
    const disc = await discover();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
    });
    const tokResp = await axios.post(disc.token_endpoint, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      validateStatus: () => true,
    });
    if (tokResp.status !== 200 || !tokResp.data || !tokResp.data.access_token) {
      throw new Error((tokResp.data && (tokResp.data.error_description || tokResp.data.error)) || `refresh grant -> HTTP ${tokResp.status}`);
    }
    return tokResp.data;
  },
};

const providers = {
  matrix: MatrixProvider,
  oidc: OidcProvider,
};

function getProvider(name) {
  return providers[name] || null;
}

module.exports = { getProvider, providers, OidcProvider };
