import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { Database } from "./socket.helper.js";
import { upload } from "./src/func/file.upload.js";

const db = new Database({
  databaseId: "c1100cc1-6193-4a30-bf4b-e8dc212243f0",
  userEmail: "joshuadivine985@gmail.com",
  author: "0600b36a-be8d-4010-a468-374b78d77a37",
  apiKey: "K7RI5UnXq4h2femzx357fBSumYj7mSdodIuE",
});

let lastDbError = null;

async function connectToFastDb() {
  const targetUrl = db.socket?.io?.uri || process.env.DB_SERVER_URL || "default";
  try {
    console.log(`Connecting to FastDB (databaseId: ${db.databaseId}) at ${targetUrl}...`);
    await db.connect();
    lastDbError = null;
    console.log(`Connected to FastDB (${db.databaseId}) at ${targetUrl}`);
  } catch (err) {
    lastDbError = err.message;
    console.error(`FastDB connection error on startup to [${targetUrl}]:`, err.message);
    console.warn(
      "Tip: If running on the Oracle instance hosting FastDB, run with DB_SERVER_URL='http://127.0.0.1:5500' to avoid public IP hairpinning."
    );
  }
}

// Connect asynchronously so server startup is never blocked
connectToFastDb();

if (db.socket) {
  db.socket.on("connect", () => {
    console.log("FastDB socket connected. Verifying database session...");
    db.connect()
      .then(() => console.log("FastDB session verified."))
      .catch((err) =>
        console.error("FastDB reconnect error:", err.message)
      );
  });
  db.socket.on("connect_error", (err) => {
    console.error("FastDB socket connection error:", err.message);
  });
}

async function ensureDbConnected() {
  if (!db.access) {
    try {
      await db.connect();
    } catch {
      // Reconnection handled via timeout in socket.helper
    }
  }
}

/**
 * Normalizes FastDB .get() results into an array of documents.
 */
async function getCollectionDocs(collectionName) {
  await ensureDbConnected();
  const raw = await db.collection(collectionName).get();
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") {
    return Object.entries(raw).map(([key, val]) =>
      val && typeof val === "object"
        ? { _id: key, ...val }
        : { _id: key, value: val }
    );
  }
  return [];
}

/**
 * Extracts the saved document and its generated _id from FastDB .add() / .set() response.
 */
function extractSavedDoc(res, fallback = {}) {
  if (!res || typeof res !== "object") {
    return fallback;
  }
  if (res._id) {
    return res;
  }
  const keys = Object.keys(res);
  if (keys.length === 1 && res[keys[0]] && typeof res[keys[0]] === "object") {
    return { _id: keys[0], ...res[keys[0]] };
  }
  return { ...fallback, ...res };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
  },
});

const port = Number(process.env.PORT) || 5500;

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use("/uploads", express.static("uploads"));

// Color palette for avatars
const AVATAR_COLORS = [
  "#1D4ED8",
  "#7C3AED",
  "#C2410C",
  "#0F766E",
  "#BE185D",
  "#15803D",
  "#0369A1",
  "#B91C1C",
  "#A16207",
  "#4338CA",
];

const getAvatarColor = (str = "") => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

const getInitials = (name = "") => {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (name.slice(0, 2) || "NZ").toUpperCase();
};

const formatChatTime = (timestamp) => {
  if (!timestamp) return "now";
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
};

const R = 6371; // km
const distKm = (a, b) => {
  if (
    !a ||
    !b ||
    !Number.isFinite(a.lat) ||
    !Number.isFinite(a.lng) ||
    !Number.isFinite(b.lat) ||
    !Number.isFinite(b.lng)
  ) {
    return null;
  }
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const getChatId = (uid1, uid2) => [uid1, uid2].sort().join("_");

const getFriendlyDistancePhrase = (distanceKm) => {
  if (distanceKm === null || distanceKm === undefined) return "Nearby";
  if (distanceKm < 0.1) return "A few steps away";
  if (distanceKm < 0.5) return "Around the corner";
  if (distanceKm < 1) return "A short walk away";
  if (distanceKm <= 5) return "In your area";
  return "Far away";
};

async function findUserByUidOrEmail(identifier) {
  if (!identifier) return null;
  const clean = String(identifier).trim().toLowerCase();
  const users = await getCollectionDocs("users");
  return (
    users.find(
      (u) =>
        String(u.uid || u._id || "").toLowerCase() === clean ||
        String(u.email || "").toLowerCase() === clean ||
        String(u.username || "").toLowerCase() === clean
    ) || null
  );
}

async function getChatsForUser(uid) {
  if (!uid) return [];
  const [usersList, chatsList, messagesList] = await Promise.all([
    getCollectionDocs("users"),
    getCollectionDocs("chats"),
    getCollectionDocs("messages"),
  ]);

  const allUsers = {};
  for (const u of usersList) {
    const key = u.uid || u._id;
    if (key) allUsers[key] = u;
  }

  const currentUser = allUsers[uid];
  if (!currentUser) return [];

  const chatList = [];
  const processedUserIds = new Set([uid]);

  for (const chat of chatsList) {
    const chatId = chat.id || chat._id;
    if (!chat.participants || !chat.participants[uid] || !chat.started) continue;

    const otherUid = Object.keys(chat.participants).find((id) => id !== uid);
    if (!otherUid) continue;

    processedUserIds.add(otherUid);
    const otherUser = allUsers[otherUid] || {
      username: "Colleague",
      pictureURL: "",
    };
    const distance = distKm(currentUser.coords, otherUser.coords);
    const isNearby = distance !== null && distance <= 5;
    const unreadCount = messagesList.filter(
      (m) => m.chatId === chatId && m.recipientId === uid && !m.read
    ).length;

    chatList.push({
      id: chatId,
      chatId,
      recipientId: otherUid,
      name: otherUser.fullName || otherUser.username || "Colleague",
      pictureURL: otherUser.pictureURL || "",
      message: chat.lastMessage?.text || "Started conversation",
      time: formatChatTime(
        chat.lastMessage?.timestamp || chat.updatedAt || chat.createdAt
      ),
      timestamp:
        chat.lastMessage?.timestamp || chat.updatedAt || chat.createdAt || 0,
      unread: unreadCount,
      online: Boolean(otherUser.online),
      isNearby,
      distanceKm: distance !== null ? Number(distance.toFixed(2)) : null,
      distanceLabel: isNearby ? getFriendlyDistancePhrase(distance) : null,
      started: true,
      color: getAvatarColor(otherUid),
      initials: getInitials(otherUser.fullName || otherUser.username || "User"),
      sent: chat.lastMessage?.senderId === uid,
    });
  }

  for (const [otherUid, otherUser] of Object.entries(allUsers)) {
    if (processedUserIds.has(otherUid)) continue;

    const distance = distKm(currentUser.coords, otherUser.coords);
    if (distance !== null && distance <= 5) {
      const deterministicChatId = getChatId(uid, otherUid);
      const unreadCount = messagesList.filter(
        (m) =>
          m.chatId === deterministicChatId && m.recipientId === uid && !m.read
      ).length;
      const distLabel = getFriendlyDistancePhrase(distance);

      chatList.push({
        id: deterministicChatId,
        chatId: deterministicChatId,
        recipientId: otherUid,
        name: otherUser.fullName || otherUser.username || "Nearby Clinician",
        pictureURL: otherUser.pictureURL || "",
        message: `Available nearby (${distLabel})`,
        time: "New",
        timestamp: otherUser.lastSeen || Date.now(),
        unread: unreadCount,
        online: Boolean(otherUser.online),
        isNearby: true,
        distanceKm: Number(distance.toFixed(2)),
        distanceLabel: distLabel,
        started: false,
        color: getAvatarColor(otherUid),
        initials: getInitials(
          otherUser.fullName || otherUser.username || "Clinician"
        ),
        sent: false,
      });
    }
  }

  chatList.sort((a, b) => {
    if (a.started && b.started) return (b.timestamp || 0) - (a.timestamp || 0);
    if (a.started && !b.started) return -1;
    if (!a.started && b.started) return 1;
    return (a.distanceKm ?? 999) - (b.distanceKm ?? 999);
  });

  return chatList;
}

async function getMessagesForChat(chatId) {
  if (!chatId) return [];
  const allMessages = await getCollectionDocs("messages");
  return allMessages
    .filter((m) => m.chatId === chatId)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

// ============================================================================
// FILE UPLOAD ENDPOINT (MULTER)
// ============================================================================
app.post("/api/upload", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }
    const url = `/uploads/${req.file.filename}`;
    res.json({
      url,
      filename: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "File upload failed" });
  }
});

// ============================================================================
// AUTH & USERS ENDPOINTS (FASTDB + MULTER)
// ============================================================================
app.post("/api/auth/register", upload.single("image"), async (req, res) => {
  try {
    const fullName = String(
      req.body.fullName || req.body.username || ""
    ).trim();
    const username = String(
      req.body.username || req.body.fullName || ""
    ).trim();
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const role = String(req.body.role || "Healthcare Professional").trim();
    const specialty = String(req.body.specialty || "General Medicine").trim();
    const institution = String(
      req.body.institution || "Medical Center"
    ).trim();
    const licenseNumber = String(req.body.licenseNumber || "").trim();
    const bio = String(req.body.bio || "").trim();
    const password = String(req.body.password || "").trim();

    if (!username && !fullName) {
      return res.status(400).json({ error: "Name or username is required" });
    }
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const existing = await findUserByUidOrEmail(email);
    if (existing) {
      return res
        .status(400)
        .json({ error: "An account with this email already exists" });
    }

    let setupPos = null;
    if (req.body.locationData) {
      try {
        setupPos =
          typeof req.body.locationData === "string"
            ? JSON.parse(req.body.locationData)
            : req.body.locationData;
      } catch {
        return res.status(400).json({ error: "Invalid location data" });
      }
    }

    const url = req.file
      ? `/uploads/${req.file.filename}`
      : req.body.pictureURL || "";

    const basePayload = {
      name: fullName || username,
      username: username || fullName,
      fullName: fullName || username,
      email,
      role,
      specialty,
      institution,
      licenseNumber,
      isVerified: Boolean(licenseNumber && licenseNumber.length > 2),
      bio:
        bio ||
        `Healthcare professional (${role} • ${specialty}) at ${institution}`,
      password,
      pictureURL: url,
      setupPos,
      coords:
        setupPos?.latitude && setupPos?.longitude
          ? { lat: setupPos.latitude, lng: setupPos.longitude }
          : null,
      online: true,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };

    // Insert document into FastDB "users" collection using .add()
    const addedRaw = await db.collection("users").add(basePayload);
    const savedDoc = extractSavedDoc(addedRaw, basePayload);
    const userKey = savedDoc._id || `med_${Date.now()}`;

    const userData = {
      ...basePayload,
      uid: userKey,
      _id: userKey,
    };

    await db.collection("users").doc(userKey).update({ uid: userKey });

    // Add clinician to FastDB "colleagues" collection so peers can discover them
    const colleagueDoc = {
      id: userKey,
      fullName: userData.fullName,
      role: userData.role,
      specialty: userData.specialty,
      institution: userData.institution,
      city: setupPos?.city || "Global Medical Campus",
      country: setupPos?.region || "Global",
      avatarUrl: url,
      isVerified: userData.isVerified,
      online: true,
      availabilityLabel: userData.specialty,
      mutualCount: 0,
      bio: userData.bio,
      connectionStatus: "none",
    };
    await db.collection("colleagues").doc(userKey).set(colleagueDoc);

    res.json({
      ...userData,
      url,
      _id: userKey,
      uid: userKey,
    });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: err.message || "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !String(email).trim()) {
      return res
        .status(400)
        .json({ error: "Email or identifier is required" });
    }

    const foundUser = await findUserByUidOrEmail(email);
    if (!foundUser) {
      return res
        .status(401)
        .json({ error: "No healthcare worker found with this credential" });
    }

    if (foundUser.password && foundUser.password !== password) {
      return res.status(401).json({ error: "Invalid password" });
    }

    const docId = foundUser._id || foundUser.uid;
    if (docId) {
      await db
        .collection("users")
        .doc(String(docId))
        .update({
          online: true,
          lastSeen: Date.now(),
        })
        .catch(() => {});
    }

    res.json({
      ...foundUser,
      uid: foundUser.uid || docId,
      _id: docId,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message || "Login failed" });
  }
});

app.get("/health", async (_req, res) => {
  res.json({
    status: "ok",
    databaseConnected: Boolean(db.access),
    dbTargetUri: db.socket?.io?.uri || null,
    dbEnvUrl: process.env.DB_SERVER_URL || null,
    socketConnected: Boolean(db.socket?.connected),
    lastDbError,
    port,
    uptime: process.uptime(),
  });
});

app.all("/api/db/reconnect", async (req, res) => {
  const target = req.query.url || req.body?.url;
  try {
    if (target && db.socket?.io) {
      console.log(`Reconnecting FastDB socket to: ${target}`);
      db.socket.io.uri = target;
      db.socket.disconnect();
      db.socket.connect();
    }
    await db.connect();
    lastDbError = null;
    res.json({
      success: true,
      databaseConnected: true,
      uri: db.socket?.io?.uri,
    });
  } catch (err) {
    lastDbError = err.message;
    res.status(500).json({
      success: false,
      databaseConnected: false,
      error: err.message,
      uri: db.socket?.io?.uri,
    });
  }
});

app.get("/api/users", async (_req, res) => {
  try {
    const users = await getCollectionDocs("users");
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/users/:uid", async (req, res) => {
  try {
    const user = await findUserByUidOrEmail(req.params.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/users/:uid", upload.single("image"), async (req, res) => {
  try {
    const { uid } = req.params;
    const existing = await findUserByUidOrEmail(uid);
    const docId = existing?._id || existing?.uid || uid;

    const updates = { ...req.body, lastSeen: Date.now() };
    if (req.file) {
      updates.pictureURL = `/uploads/${req.file.filename}`;
      updates.url = updates.pictureURL;
    }
    if (typeof updates.isVerified === "string") {
      updates.isVerified = updates.isVerified === "true";
    }

    const merged = {
      ...(existing || { uid }),
      ...updates,
      uid: existing?.uid || uid,
    };

    await db.collection("users").doc(String(docId)).set(merged);

    // Keep colleague directory entry in sync
    const colId = existing?.uid || uid;
    await db
      .collection("colleagues")
      .doc(String(colId))
      .set({
        id: String(colId),
        fullName: merged.fullName || merged.username || "Clinician",
        role: merged.role || "Healthcare Professional",
        specialty: merged.specialty || "General Medicine",
        institution: merged.institution || "Medical Center",
        city: merged.setupPos?.city || "Global Medical Campus",
        country: merged.setupPos?.region || "Global",
        avatarUrl: merged.pictureURL || "",
        isVerified: Boolean(merged.isVerified),
        online: true,
        availabilityLabel: merged.specialty || "Active",
        mutualCount: 0,
        bio: merged.bio || "",
        connectionStatus: "none",
      })
      .catch(() => {});

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to update profile" });
  }
});

// ============================================================================
// NAZORA SOCIAL COLLECTIONS (POSTS, STORIES, GROUPS, REELS, COLLEAGUES, CHATS)
// ============================================================================

// --- POSTS ---
app.get("/api/posts", async (_req, res) => {
  try {
    const posts = await getCollectionDocs("posts");
    posts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/posts", upload.single("image"), async (req, res) => {
  try {
    let postData = req.body;
    if (typeof req.body.post === "string") {
      postData = JSON.parse(req.body.post);
    }
    if (req.file) {
      postData.imageUrl = `/uploads/${req.file.filename}`;
    }
    const postId = postData.id || `post_${Date.now()}`;
    const fullPost = {
      ...postData,
      id: postId,
      timestamp: postData.timestamp || Date.now(),
    };
    await db.collection("posts").doc(String(postId)).set(fullPost);
    io.emit("posts:new", fullPost);
    res.json(fullPost);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/posts", async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body.posts || [];
    for (const item of list) {
      const docId = item.id || item._id || `post_${Date.now()}`;
      await db.collection("posts").doc(String(docId)).set({ ...item, id: docId });
    }
    res.json({ success: true, count: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updatedPost = { ...req.body, id };
    await db.collection("posts").doc(String(id)).set(updatedPost);
    res.json(updatedPost);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- STORIES ---
app.get("/api/stories", async (_req, res) => {
  try {
    const stories = await getCollectionDocs("stories");
    res.json(stories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/stories", upload.single("image"), async (req, res) => {
  try {
    let storyData = req.body;
    if (typeof req.body.story === "string") {
      storyData = JSON.parse(req.body.story);
    }
    if (req.file) {
      storyData.mediaUrl = `/uploads/${req.file.filename}`;
    }
    const storyId = storyData.id || `story_${Date.now()}`;
    const fullStory = { ...storyData, id: storyId };
    await db.collection("stories").doc(String(storyId)).set(fullStory);
    res.json(fullStory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/stories", async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body.stories || [];
    for (const item of list) {
      const docId = item.id || item._id || `story_${Date.now()}`;
      await db.collection("stories").doc(String(docId)).set({ ...item, id: docId });
    }
    res.json({ success: true, count: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GROUPS ---
app.get("/api/groups", async (_req, res) => {
  try {
    const groups = await getCollectionDocs("groups");
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/groups", upload.single("image"), async (req, res) => {
  try {
    let groupData = req.body;
    if (typeof req.body.group === "string") {
      groupData = JSON.parse(req.body.group);
    }
    if (req.file) {
      groupData.coverUrl = `/uploads/${req.file.filename}`;
    }
    const groupId = groupData.id || `grp_${Date.now()}`;
    const fullGroup = { ...groupData, id: groupId };
    await db.collection("groups").doc(String(groupId)).set(fullGroup);
    res.json(fullGroup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/groups", async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body.groups || [];
    for (const item of list) {
      const docId = item.id || item._id || `grp_${Date.now()}`;
      await db.collection("groups").doc(String(docId)).set({ ...item, id: docId });
    }
    res.json({ success: true, count: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- REELS ---
app.get("/api/reels", async (_req, res) => {
  try {
    const reels = await getCollectionDocs("reels");
    res.json(reels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/reels", upload.single("image"), async (req, res) => {
  try {
    let reelData = req.body;
    if (typeof req.body.reel === "string") {
      reelData = JSON.parse(req.body.reel);
    }
    if (req.file) {
      reelData.thumbnailUrl = `/uploads/${req.file.filename}`;
    }
    const reelId = reelData.id || `reel_${Date.now()}`;
    const fullReel = { ...reelData, id: reelId };
    await db.collection("reels").doc(String(reelId)).set(fullReel);
    res.json(fullReel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/reels", async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body.reels || [];
    for (const item of list) {
      const docId = item.id || item._id || `reel_${Date.now()}`;
      await db.collection("reels").doc(String(docId)).set({ ...item, id: docId });
    }
    res.json({ success: true, count: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- COLLEAGUES ---
app.get("/api/colleagues", async (_req, res) => {
  try {
    const [colleagues, users] = await Promise.all([
      getCollectionDocs("colleagues"),
      getCollectionDocs("users"),
    ]);
    const map = new Map();
    for (const c of colleagues) {
      const id = c.id || c._id;
      if (id) map.set(String(id), { ...c, id: String(id) });
    }
    for (const u of users) {
      const id = u.uid || u._id;
      if (id && !map.has(String(id))) {
        map.set(String(id), {
          id: String(id),
          fullName: u.fullName || u.username || "Clinician",
          role: u.role || "Healthcare Professional",
          specialty: u.specialty || "General Medicine",
          institution: u.institution || "Medical Center",
          city: u.setupPos?.city || "Global Medical Campus",
          country: u.setupPos?.region || "Global",
          avatarUrl: u.pictureURL || "",
          isVerified: Boolean(u.isVerified),
          online: Boolean(u.online),
          availabilityLabel: u.specialty || "Active",
          mutualCount: 0,
          bio: u.bio || "",
          connectionStatus: "none",
        });
      }
    }
    res.json(Array.from(map.values()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/colleagues", async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : req.body.colleagues || [];
    for (const item of list) {
      const docId = item.id || item._id || `col_${Date.now()}`;
      await db
        .collection("colleagues")
        .doc(String(docId))
        .set({ ...item, id: docId });
    }
    res.json({ success: true, count: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CONVERSATIONS ---
app.get("/api/conversations", async (_req, res) => {
  try {
    const conversations = await getCollectionDocs("conversations");
    res.json(conversations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/conversations", async (req, res) => {
  try {
    const list = Array.isArray(req.body)
      ? req.body
      : req.body.conversations || [];
    for (const item of list) {
      const docId = item.id || item._id || `conv_${Date.now()}`;
      await db
        .collection("conversations")
        .doc(String(docId))
        .set({ ...item, id: docId });
    }
    res.json({ success: true, count: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(
  "/api/conversations/:id/messages",
  upload.single("image"),
  async (req, res) => {
    try {
      const { id } = req.params;
      let msgData = req.body;
      if (typeof req.body.message === "string") {
        msgData = JSON.parse(req.body.message);
      }
      if (req.file) {
        msgData.imageUrl = `/uploads/${req.file.filename}`;
      }

      const existing = await db.collection("conversations").doc(String(id)).get();
      if (existing) {
        const nextMessages = [...(existing.messages || []), msgData];
        const updatedConv = {
          ...existing,
          lastMessage: msgData.text || "Shared a clinical image",
          lastTime: "Just now",
          messages: nextMessages,
        };
        await db.collection("conversations").doc(String(id)).set(updatedConv);
        io.emit("conversation:message", { conversationId: id, message: msgData });
        return res.json(updatedConv);
      }
      res.json(msgData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// --- NOTIFICATIONS ---
app.get("/api/notifications", async (_req, res) => {
  try {
    const notifications = await getCollectionDocs("notifications");
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/notifications", async (req, res) => {
  try {
    const list = Array.isArray(req.body)
      ? req.body
      : req.body.notifications || [];
    for (const item of list) {
      const docId = item.id || item._id || `notif_${Date.now()}`;
      await db
        .collection("notifications")
        .doc(String(docId))
        .set({ ...item, id: docId });
    }
    res.json({ success: true, count: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PROXIMITY CHATS ---
app.get("/api/chats/:uid", async (req, res) => {
  try {
    const chats = await getChatsForUser(req.params.uid);
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/chats/:chatId/messages", async (req, res) => {
  try {
    const messages = await getMessagesForChat(req.params.chatId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// SOCKET.IO EVENTS (BACKED BY FASTDB)
// ============================================================================
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("user:join", async ({ uid }) => {
    if (!uid) return;
    socket.data.uid = uid;
    socket.join(`user:${uid}`);

    try {
      const user = await findUserByUidOrEmail(uid);
      if (user) {
        const docId = user._id || user.uid;
        await db.collection("users").doc(String(docId)).update({
          online: true,
          socketId: socket.id,
          lastSeen: Date.now(),
        });
      }

      const userChats = await getChatsForUser(uid);
      socket.emit("chats:update", userChats);
    } catch (err) {
      console.error("user:join failed", err);
    }
  });

  socket.on("location:update", async ({ uid, lat, lng } = {}) => {
    try {
      if (!uid || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

      socket.data.uid = uid;
      socket.join(`user:${uid}`);

      const user = await findUserByUidOrEmail(uid);
      if (user) {
        const docId = user._id || user.uid;
        await db.collection("users").doc(String(docId)).update({
          coords: { lat, lng },
          online: true,
          lastSeen: Date.now(),
        });
      }

      const userChats = await getChatsForUser(uid);
      socket.emit("chats:update", userChats);
      socket.emit(
        "location:update",
        userChats.filter((c) => c.isNearby)
      );

      const allUsers = await getCollectionDocs("users");
      for (const otherUser of allUsers) {
        const otherUid = otherUser.uid || otherUser._id;
        if (!otherUid || otherUid === uid || !otherUser.online) continue;
        const otherChats = await getChatsForUser(otherUid);
        io.to(`user:${otherUid}`).emit("chats:update", otherChats);
      }
    } catch (err) {
      console.error("location:update failed", err);
    }
  });

  socket.on("chat:join", async ({ chatId }) => {
    if (!chatId) return;
    socket.join(`chat:${chatId}`);
    try {
      const messages = await getMessagesForChat(chatId);
      socket.emit("messages:list", { chatId, messages });
    } catch (err) {
      console.error("chat:join error", err);
    }
  });

  socket.on("messages:get", async ({ chatId }) => {
    if (!chatId) return;
    try {
      const messages = await getMessagesForChat(chatId);
      socket.emit("messages:list", { chatId, messages });
    } catch (err) {
      console.error("messages:get error", err);
    }
  });

  socket.on("message:send", async ({ chatId, senderId, recipientId, text }) => {
    try {
      if (!senderId || !recipientId || !text || !text.trim()) return;
      if (
        senderId === recipientId ||
        (senderId === "me" && recipientId === "me")
      ) {
        console.warn(`[FastDB Socket] Blocked user ${senderId} from messaging themselves.`);
        return;
      }

      const trimmedText = text.trim();
      const realChatId = chatId || getChatId(senderId, recipientId);
      const timestamp = Date.now();
      const msgKey = `msg_${timestamp}_${Math.random().toString(36).slice(2, 7)}`;

      const messageData = {
        id: msgKey,
        chatId: realChatId,
        senderId,
        recipientId,
        text: trimmedText,
        timestamp,
        read: false,
      };

      await db.collection("messages").doc(msgKey).set(messageData);

      await db.collection("chats").doc(realChatId).set({
        id: realChatId,
        participants: {
          [senderId]: true,
          [recipientId]: true,
        },
        started: true,
        lastMessage: {
          text: trimmedText,
          senderId,
          timestamp,
        },
        updatedAt: timestamp,
      });

      io.to(`chat:${realChatId}`).emit("message:new", messageData);
      io.to(`user:${recipientId}`).emit("message:new", messageData);
      io.to(`user:${senderId}`).emit("message:new", messageData);
      socket.emit("message:new", messageData);

      const [senderChats, recipientChats] = await Promise.all([
        getChatsForUser(senderId),
        getChatsForUser(recipientId),
      ]);
      io.to(`user:${senderId}`).emit("chats:update", senderChats);
      io.to(`user:${recipientId}`).emit("chats:update", recipientChats);
    } catch (err) {
      console.error("message:send failed", err);
    }
  });

  socket.on("messages:read", async ({ chatId, uid }) => {
    try {
      if (!chatId || !uid) return;
      const msgs = await getMessagesForChat(chatId);
      let updatedAny = false;
      for (const msg of msgs) {
        if (msg.recipientId === uid && !msg.read) {
          const docId = msg._id || msg.id;
          if (docId) {
            await db.collection("messages").doc(String(docId)).update({ read: true });
            updatedAny = true;
          }
        }
      }
      if (updatedAny) {
        io.to(`chat:${chatId}`).emit("messages:read", {
          chatId,
          readerId: uid,
        });
        const userChats = await getChatsForUser(uid);
        socket.emit("chats:update", userChats);
      }
    } catch (err) {
      console.error("messages:read failed", err);
    }
  });

  socket.on("disconnect", async (reason) => {
    console.log(`Client disconnected: ${socket.id} (${reason})`);
    const uid = socket.data.uid;
    if (uid) {
      try {
        const user = await findUserByUidOrEmail(uid);
        if (user) {
          const docId = user._id || user.uid;
          await db.collection("users").doc(String(docId)).update({
            online: false,
            lastSeen: Date.now(),
          });
        }
      } catch (err) {
        console.error("disconnect cleanup error", err);
      }
    }
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Nazora FastDB server listening on http://0.0.0.0:${port}`);
});
