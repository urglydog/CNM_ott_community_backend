# Agora RTC Web SDK 4.x — Quick Reference

## Core Concepts

- **App ID**: Unique project identifier from Agora Console. Shared between client and server.
- **App Certificate**: Used server-side only to generate tokens. Never sent to frontend.
- **Channel**: A named room where users communicate. Multiple users join the same channel name to communicate.
- **UID (User ID)**: Numeric identifier for each user in a channel. Must be unique per user per channel. Can be 0 (auto-assign) or a specific positive integer.

## Token Authentication

- Tokens are generated server-side using `agora-access-token` (Node.js).
- `RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channelName, uid, role, privilegeExpiredTs)`
- Role: `RtcRole.PUBLISHER` (1) for most users, `RtcRole.SUBSCRIBER` (2) for audience.
- Tokens have an expiry time (e.g., 3600 seconds).
- Each user needs their own token for the same channel.
- The same channel name must be used by all participants.

## Client Join Flow

```js
import AgoraRTC from "agora-rtc-sdk-ng";

const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

// Join channel
const uid = await client.join(appId, channelName, token, null);
// uid is the assigned user ID (matches what was used to generate the token)

// Create and publish local tracks
const micTrack = await AgoraRTC.createMicrophoneAudioTrack();
const camTrack = await AgoraRTC.createCameraVideoTrack();
await client.publish([micTrack, camTrack]);

// Subscribe to remote users
client.on("user-published", async (user, mediaType) => {
  await client.subscribe(user, mediaType);
  if (mediaType === "video") {
    // user.videoTrack.play("dom-element-id");
  }
  if (mediaType === "audio") {
    user.audioTrack.play();
  }
});

client.on("user-unpublished", (user, mediaType) => {
  // Handle remote user stopping media
});

// Leave channel
await client.leave();
micTrack.close();
camTrack.close();
```

## Key Events

- `user-published`: Another user published a media track. Subscribe to it.
- `user-unpublished`: A user unpublished their media track.
- `user-joined`: A new user joined the channel.
- `user-left`: A user left the channel.
- `connection-state-change`: Connection state changed.
- `token-privilege-will-expire`: Token is about to expire, renew it.
- `token-privilege-did-expire`: Token expired, must rejoin with new token.

## Group Call Guidelines

- All participants join the SAME Agora channel with the SAME channel name.
- Each participant has a UNIQUE uid.
- The channel name is generated once (typically from the session ID).
- Tokens are generated per-user per-channel.
- Agora handles multi-party automatically — no special group API needed.
- Client SDK automatically receives all remote users who have published.
- Leave channel does not end the session for other users.
- Session ends only when backend marks it as ENDED.

## Important Rules

- Never store App Certificate in frontend code.
- Generate tokens server-side only.
- Use the same channelName for all participants in a session.
- Each user must have a unique uid within a channel.
- Do NOT assume a 1:1 call model — Agora supports N:N natively.
- Clean up local tracks when leaving (close audio/video tracks).
- Do not call `client.leave()` until the user explicitly leaves or session ends.