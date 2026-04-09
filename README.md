# CNM_ott_community-backend

## Send file or image message

After uploading a file to S3 with the presigned URL endpoint, send the public file URL as a normal message payload.

### Socket.io

Emit `send-message` with this payload shape:

```json
{
  "conversationId": "channel:1",
  "senderId": 12,
  "contentType": "image",
  "content": "",
  "attachments": [
    {
      "url": "https://your-bucket.s3.ap-southeast-1.amazonaws.com/uploads/image-1.png",
      "key": "uploads/image-1.png",
      "name": "image-1.png",
      "mimeType": "image/png",
      "size": 245678
    }
  ]
}
```

### HTTP

You can also use:

- `POST /api/messages`
- `POST /api/messages/channel`
- `POST /api/messages/direct`

The body format is the same as the Socket payload. For channel/direct routes, you can pass `channelId` or `directChatId` instead of `conversationId`.

## Postman test flow

Use the `OTT File Attachments` folder in `api.json` in this order:

1. `POST get presigned upload URL`
2. `PUT upload file to S3`
3. `POST send attached channel message`
4. `GET verify channel messages`

For step 2, open the request in Postman, switch Body to binary/file, and select a local file manually. The upload URL is injected from step 1 through the `uploadUrl` variable.
