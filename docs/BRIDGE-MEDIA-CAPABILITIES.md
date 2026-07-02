# Bridge Media Capabilities

Bridge adapters declare their accepted media inputs and native delivery modes through `createMediaCapabilities`. The declaration in each adapter is the executable source of truth; this page records the user-facing contract.

| Platform | Inputs | Kinds | Reply context | Native delivery |
| --- | --- | --- | --- | --- |
| Telegram | buffer, remote URL, public URL | image, video, audio, document | No | image, video, audio, document |
| Feishu | buffer, remote URL, public URL | image, video, audio, document | No | images as image messages; other kinds as files |
| WeChat iLink | buffer, remote URL, public URL | image, video, audio, document | Yes | images as image messages; other kinds as files |
| QQ | local file, remote URL, public URL | image, video, audio, document | No | official Bot rich-media upload |

## Telegram

Buffered images are limited to 10 MiB; other buffered kinds are limited to 50 MiB. Remote images are limited to 5 MiB and other remote kinds to 20 MiB.

## Feishu

Buffered images are limited to 10 MiB; other buffered kinds are limited to 30 MiB. The adapter uploads bytes to Feishu before sending the message.

## WeChat iLink

Outbound media requires the inbound reply context used by iLink. The adapter uploads and encrypts media through the iLink/CDN flow before sending it.

## Public URL fallback

`preferences.bridge.mediaPublicBaseUrl` / `HANA_BRIDGE_PUBLIC_BASE_URL` is only for adapters or remote fallbacks that require a public URL. Hana does not create a tunnel automatically. Temporary media routes remain protected by short-lived tokens, download limits, and local path allowlists.
