import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import admin from "firebase-admin";
import fs from "fs";
import { AccessToken } from "livekit-server-sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Firebase Admin init ----------
const saPath = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!saPath || !fs.existsSync(saPath)) {
  console.error("❌ Missing Firebase service account JSON at:", saPath);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(saPath, "utf8"))),
});

// ---------- In-memory store (for quick testing) ----------
/**
 * calls[callId] = {
 *   callId, roomName,
 *   callerId, callerName, callerFcmToken,
 *   calleeId, calleeFcmToken,
 *   status: "ringing" | "accepted" | "ended",
 *   createdAt, acceptedAt, endedAt
 * }
 */
const calls = new Map();

/**
 * userTokens[userId] = fcmToken
 */
const userTokens = new Map();

// ---------- Helpers ----------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function mintLiveKitToken({ identity, name, roomName }) {
  const apiKey = requireEnv("LIVEKIT_API_KEY");
  const apiSecret = requireEnv("LIVEKIT_API_SECRET");

  const at = new AccessToken(apiKey, apiSecret, { identity, name });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  return await at.toJwt();
}

async function sendPush({ token, data }) {
  if (!token) throw new Error("Missing FCM token for push");

  const msg = {
    token,
    android: {
      priority: "high",
      ttl: 30 * 1000, // 30s
    },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
  };

  const messageId = await admin.messaging().send(msg);
  return messageId;
}

async function sendIncomingCallPush({ calleeFcmToken, callId, callerName }) {
  const msg = {
    token: calleeFcmToken,
    android: {
      priority: "high",
      ttl: 60 * 1000,
      notification: {
        channelId: "calls",
        sound: "default",
      },
    },
    notification: {
      title: "Incoming call",
      body: `${callerName} is calling`,
    },
    data: {
      type: "incoming_call",
      callId,
      callerName,
    },
  };

  return admin.messaging().send(msg);
}

// Optional: notify caller that call was accepted (handy to open caller ongoing UI)
async function sendCallAcceptedPush({ callerFcmToken, callId, roomName }) {
  if (!callerFcmToken) return null;

  return sendPush({
    token: callerFcmToken,
    data: {
      type: "call_accepted",
      callId,
      roomName,
    },
  });
}

// ---------- APIs ----------

// Health check
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * Register device token so backend can push to that user.
 *
 * POST /devices/register
 * { userId: "u1", fcmToken: "..." }
 */
app.post("/devices/register", (req, res) => {
  const { userId, fcmToken } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: "userId required" });
  }
  if (!fcmToken) {
    return res.status(400).json({ error: "fcmToken required (FCM token is empty/null)" });
  }

  userTokens.set(userId, fcmToken);

  console.log("✅ Device registered:", { userId, fcmToken: `${String(fcmToken).slice(0, 12)}...` });

  res.json({ ok: true });
});

/**
 * Start call:
 * POST /calls/start
 * { callerId, callerName, calleeId }
 *
 * Creates callId, sets status=ringing, pushes incoming call to callee.
 */
app.post("/calls/start", async (req, res) => {
  try {
    const { callerId, callerName, calleeId } = req.body || {};
    if (!callerId || !callerName || !calleeId) {
      return res.status(400).json({ error: "callerId, callerName, calleeId required" });
    }

    const calleeFcmToken = userTokens.get(calleeId);
    if (!calleeFcmToken) {
      return res.status(400).json({
        error: `No FCM token registered for calleeId=${calleeId}. Call /devices/register from callee first.`,
      });
    }

    const callerFcmToken = userTokens.get(callerId) || null; // optional

    const callId = uuidv4();
    const roomName = `call_${callId}`;

    const call = {
      callId,
      roomName,
      callerId,
      callerName,
      callerFcmToken,
      calleeId,
      calleeFcmToken,
      status: "ringing",
      createdAt: Date.now(),
      acceptedAt: null,
      endedAt: null,
    };

    calls.set(callId, call);

    console.log("📞 Call start:", {
      callId,
      roomName,
      callerId,
      calleeId,
      status: call.status,
    });

    const pushId = await sendIncomingCallPush({ calleeFcmToken, callId, callerName });
    console.log("✅ Incoming call push sent:", pushId);

    res.json({
      callId,
      roomName,
      status: "ringing",
      pushId,
    });
  } catch (e) {
    console.error("❌ /calls/start error:", e);
    res.status(500).json({ error: e?.message || "start failed" });
  }
});

/**
 * Accept call:
 * POST /calls/accept
 * { callId, userId, userName }
 *
 * Returns LiveKit token + URL so client can connect.
 * Called when user presses "Accept".
 */
app.post("/calls/accept", async (req, res) => {
  try {
    const { callId, userId, userName } = req.body || {};
    if (!callId || !userId || !userName) {
      return res.status(400).json({ error: "callId, userId, userName required" });
    }

    const call = calls.get(callId);
    if (!call) return res.status(404).json({ error: "call not found" });
    if (call.status === "ended") return res.status(410).json({ error: "call already ended" });

    // Mark accepted (idempotent)
    call.status = "accepted";
    call.acceptedAt = call.acceptedAt || Date.now();
    calls.set(callId, call);

    const livekitUrl = requireEnv("LIVEKIT_URL");
    const token = await mintLiveKitToken({
      identity: userId,
      name: userName,
      roomName: call.roomName,
    });

    console.log("✅ Call accepted:", { callId, userId, roomName: call.roomName });
    console.log("🔑 Generated token:", token.substring(0, 30) + "... (length=" + token.length + ")");

    // Optional: tell caller "call accepted" (useful for caller side ongoing UI)
    try {
      const pushId = await sendCallAcceptedPush({
        callerFcmToken: call.callerFcmToken,
        callId,
        roomName: call.roomName,
      });
      if (pushId) console.log("✅ Call accepted push to caller:", pushId);
    } catch (e) {
      console.warn("⚠️ Failed to send call_accepted push:", e?.message || e);
    }

    res.json({
      livekitUrl,
      token,
      roomName: call.roomName,
      callId,
      status: call.status,
      acceptedAt: call.acceptedAt,
    });
  } catch (e) {
    console.error("❌ /calls/accept error:", e);
    res.status(500).json({ error: e?.message || "accept failed" });
  }
});

/**
 * End call:
 * POST /calls/end
 * { callId }
 */
app.post("/calls/end", async (req, res) => {
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: "callId required" });

  const call = calls.get(callId);
  if (call) {
    call.status = "ended";
    call.endedAt = Date.now();
    calls.set(callId, call);
    console.log("📴 Call ended:", { callId });

    // Notify both caller and callee that call ended
    const promises = [];
    
    if (call.callerFcmToken) {
      promises.push(
        sendPush({
          token: call.callerFcmToken,
          data: { type: "call_ended", callId },
        }).catch(e => console.warn("⚠️ Failed to notify caller:", e?.message))
      );
    }
    
    if (call.calleeFcmToken) {
      promises.push(
        sendPush({
          token: call.calleeFcmToken,
          data: { type: "call_ended", callId },
        }).catch(e => console.warn("⚠️ Failed to notify callee:", e?.message))
      );
    }

    await Promise.all(promises);
    console.log("✅ Call ended notifications sent");
  }

  res.json({ ok: true });
});

/**
 * Get call status (useful for debugging / polling)
 * GET /calls/status/:callId
 */
app.get("/calls/status/:callId", (req, res) => {
  const { callId } = req.params;
  const call = calls.get(callId);
  if (!call) return res.status(404).json({ error: "call not found" });

  res.json({
    callId: call.callId,
    roomName: call.roomName,
    callerId: call.callerId,
    calleeId: call.calleeId,
    status: call.status,
    createdAt: call.createdAt,
    acceptedAt: call.acceptedAt,
    endedAt: call.endedAt,
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`✅ Backend running on http://localhost:${port}`));