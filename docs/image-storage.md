# Image storage

How pictures are stored on a board, what the free limits are, and how to move to a different storage service later. Written 2026-10-07.

## What we use today: MongoDB GridFS

Uploaded images are kept in the same MongoDB database as everything else, using **GridFS**. GridFS is MongoDB's built-in way to store files: each file is cut into 255 KB pieces that are saved as ordinary documents in two collections, `images.files` (name, size, type, which board) and `images.chunks` (the bytes). There is no extra account, key or service.

**Why this first:** the app deploys with one MongoDB connection string and nothing else. Image upload works on a fresh deploy and in local development without any setup.

**The catch:** the free Atlas tier (M0) has **512 MB in total**, shared by boards, version history, comments, notifications and images. A photo is shrunk to about 300 KB to 1 MB before upload, so the whole database fits roughly 500 to 1,500 images, fewer as board data grows. Every image view also goes through the Render server, which uses its bandwidth and wakes it from sleep.

### How it works

```
browser                                   server                         MongoDB
  |  pick / paste / drop a picture          |                               |
  |  shrink to <= 2000 px, WebP, <= 1.8 MB  |                               |
  |-- socket "board:image" (bytes) -------->|  can this person edit?        |
  |                                         |  is it really a PNG/JPEG/     |
  |                                         |  WebP/GIF? under 2 MB?        |
  |                                         |  room on the board (25 MB),   |
  |                                         |  the owner (100 MB) and the   |
  |                                         |  app (300 MB)? If not, refuse |
  |                                         |  and sweep unused images in   |
  |                                         |  the background               |
  |                                         |-- GridFS write -------------->|
  |<-- { ok, id } --------------------------|                               |
  |  adds { type: "image", imageId, x1..y2 } to the board like any element    |
  |                                                                         |
  |  <img src="/api/images/<id>"> -------> GET /api/images/:id -- stream -->|
```

- **Uploads go over the board's socket**, not a separate HTTP call, so they pass the same permission check as drawing: invited editors and people with an edit link (guests included) can add images, link viewers cannot.
- **The board only stores the image id**, never the bytes. Elements stay small, so sync, saving and version history are unaffected.
- **Downloads are public by unguessable id.** An image id is 128 random bits and nobody can guess one. Ids reach whoever has the board's elements: its members, anyone with a link to it, and anyone who was a member or had the link while the image was on it (ids also sit in saved versions). Nobody gets one by any other route. This is the same approach Google Docs and Miro use for embedded images. The trade-off: an image link someone kept keeps working after the owner closes the board's link, until the picture itself is removed. Signed, short-lived URLs would be stricter but need a request per image view.
- **Uploads are handled one at a time per board owner**, so two arriving together can't both squeeze into space only one of them fits. Different owners don't wait for each other (together they can overshoot the app-wide limit by an upload or two), and a storage write that hangs is given up after 30 seconds. An account (a guest's board, for guests) can upload 30 pictures a minute, and one network address 90. The server logs a warning when the app's image space passes 80%.
- **The server reads each picture's size from its header** (PNG, JPEG, GIF and WebP) and refuses one more than 4096 px on a side, or one whose header can't be read, so a small file can't declare a picture that every viewer's browser has to decode. A small copy that is over 512 px is dropped, and the full picture is used for thumbnails.
- **Images never change under their id**, so they are served with `Cache-Control: private, max-age=86400, immutable`: the viewer's browser keeps a picture for a day, but shared caches and CDNs don't keep it, so a removed picture stops being served soon after. `Cross-Origin-Resource-Policy` is `cross-origin` whenever the app may be on another address than the API: when `CLIENT_ORIGIN` is set, and outside production when it isn't (it then defaults to the Vite dev server, `http://localhost:5173`). Only in production with `CLIENT_ORIGIN` unset, where the server serves the app itself, is it `same-origin`.

### Limits (all in the code, easy to change)

| Limit | Value | Where |
| --- | --- | --- |
| Picked file, before shrinking | 25 MB | `client/src/features/board/images.ts` |
| Longest side after shrinking | 2000 px | same |
| Files up to 400 KB and 2000 px | uploaded untouched | same |
| Small copy for thumbnails | 400 px, at most 200 KB | same, and `IMAGE_LIMITS.small` on the server |
| One stored image | 2 MB, at most 4096 px on a side | `shared/src/limits.ts` (the browser shrinks to fit under it), applied in `server/src/services/images.ts` |
| Images per board | 25 MB | same (`IMAGE_LIMITS`) |
| Images across all the boards one account owns, whoever added them | 100 MB (20 MB while the account's email address is unconfirmed, once email is set up) | same |
| Images in the whole app | 300 MB | same |
| How long an image nothing shows is kept after upload | 1 hour | same |
| Uploads per account (or guest board) / per network address per minute | 30 / 90 | same |
| Pictures added at once | 10 | `BoardEditor.jsx` |
| Formats | PNG, JPEG, WebP, GIF, checked by their first bytes. **SVG is refused** because it can carry scripts | `images.js` (server) |

Animated GIFs are drawn as a still picture, because the board is a canvas.

### Known gaps

- **Space comes back slowly.** Deleting a picture doesn't delete its file straight away, because undo and version history can bring it back. A sweep deletes images that neither their board nor any of its saved versions shows, once they are over an hour old. It runs every 6 hours, and when an upload is refused for want of room it starts in the background (the refused upload doesn't wait for it; trying again a moment later finds the room it made). Those background sweeps cover the owner's boards when the board or owner limit ran out, at most every 30 seconds per owner, or every image in the app when the app-wide limit did, at most every 30 seconds in all (one shared scope for everyone). A picture that made it into a version is kept until that version goes: automatic versions roll off after 50 newer ones (sooner when the board's history is over its 30 MB budget), named versions stay until someone deletes them. Undoing the deletion of a swept picture shows a crossed-out box. All of a board's files go when the board is deleted for good.
- **Templates leave images out.** A template outlives the board it came from, and images belong to a board. Saving a board as a template skips its pictures.
- **Thumbnails use a small copy.** With each picture the browser also uploads a copy about 400 px on the long side (WebP, at most 200 KB, checked like the picture). Dashboard cards and version history draw from it at `/api/images/:id/small`; pictures uploaded before small copies existed fall back to the full file there.
- **Owners can see their space** in Settings, under "Image space": how much of their 100 MB the pictures on their boards take, and each board's share of its 25 MB, biggest first (`GET /api/boards/image-usage`).
- **Images count against the board's owner**, not the person who added them, since guests have no account to count against. Someone with an edit link can use up the owner's space; the owner can close the link.

## Moving to Cloudflare R2 (built in, off until you set it up)

The server can keep images' bytes in Cloudflare R2 instead. It stays off until all four `R2_*` variables are set, and the server refuses to start with only some of them. Each image keeps its entry in `images.files`, so the space limits, sweeps and copies work the same way. Only the bytes move: an entry marked `storage: "r2"` has its bytes in the bucket under `images/<id>`, and any other entry has them in `images.chunks`. So pictures uploaded before the switch keep working, served from GridFS, until they're moved.

Images are still served through the server at `/api/images/:id`, with the same cache and cross-origin headers. Requests to R2 are signed with [aws4fetch](https://github.com/mhart/aws4fetch). With R2 on, the app-wide image limit goes from 300 MB to 9 GB (R2's free plan holds 10 GB). The per-board and per-owner limits stay the same.

**To switch:**

1. In Cloudflare, create an R2 bucket (keep it private) and an R2 API token with *Object Read & Write* on that bucket. Note the account id, the token's access key id and secret, and the bucket name.
2. On Render, set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` on the service, then redeploy. New uploads now go to R2.
3. Move the pictures already uploaded: with the same four variables and the production `MONGODB_URI` in `server/.env`, run `npm run move-images-to-r2 -w server` once. Each picture is written to R2 before its entry says so, and its chunks are deleted after, so you can stop the script and run it again. Run it when few people are uploading or deleting: a picture deleted while it's being moved can leave its copy behind in the bucket.

**Don't turn R2 off again** once pictures are in it. Images marked `storage: "r2"` can't be read without the keys. There is no script to move them back.

## The alternatives, for later

The server talks to storage through the functions in `server/src/services/image-storage.ts`: `putImage`, `openImage`, `imageBytes`, `imageBytesByBoard`, `imageBytesAmong`, `listImages`, `copyImages`, `deleteImages` and `deleteBoardImages`. The limits and the sweep in `images.js` only use those. Moving to another service means rewriting that one file. Boards and saved images do not change, because elements only hold the id.

### Cloudflare R2

An S3-compatible object store.

| | |
| --- | --- |
| Free allowance | 10 GB storage, 1 million writes and 10 million reads a month |
| Download fees | None. Egress is free at every volume |
| Beyond the free tier | $0.015 per GB a month |
| Account | A Cloudflare account. As far as we know a payment card is required even for the free tier (not confirmed) |
| Keys | Account id, access key and secret, a bucket name |

**Good:** by far the most room for the money, and no bandwidth bill if the app becomes popular. Images can be served straight from R2 (or a custom domain on it), taking load off the Render server.
**Not so good:** a new account and three more secrets to configure, and the card requirement. We do the shrinking ourselves, as we already do.

**Switching:** built in, see [Moving to Cloudflare R2](#moving-to-cloudflare-r2-built-in-off-until-you-set-it-up). Serving straight from R2 (a public bucket or a custom domain on it) would take the load off the server, but it would need public URLs. That isn't built.

### Cloudinary

An image service that also resizes, converts and delivers images from a CDN.

| | |
| --- | --- |
| Free allowance | 25 credits a month. One credit is 1 GB of storage, or 1 GB of downloads, or 1,000 transformations, drawn from a single pool |
| Account | A Cloudinary account, no card needed |
| Keys | Cloud name, API key and secret |

**Good:** it makes thumbnails and the right size per screen on request, so our own shrinking and the future thumbnail work come for free, and the CDN is fast.
**Not so good:** storage and downloads share a small pool (25 GB in all), so popularity burns it quickly. Image links would point at Cloudinary, which is harder to leave later. It is built for images only.

**Switching:** use the Cloudinary Node SDK's upload stream, with the image id as the public id and the board id as a folder. Serve by redirecting `/api/images/:id` to the Cloudinary URL, or by having the client use the Cloudinary URL directly with size parameters.

### Which to pick when

| Situation | Choice |
| --- | --- |
| Building, demos, a few users | GridFS (what we have) |
| Real users, image-heavy boards, or the database nearing 512 MB | **R2** |
| You want automatic thumbnails and format conversion, and expect modest traffic | Cloudinary |

Watch the database size in the Atlas dashboard. A good moment to move is when it passes about 300 MB.

Sources: [MongoDB Atlas free tier](https://oneuptime.com/blog/post/2026-03-31-mongodb-atlas-free-tier-setup/markdown), [Cloudflare R2 pricing](https://filebase.com/blog/cloudflare-r2-pricing-costs-savings-and-alternatives-in-2026/), [Cloudinary plans](https://cloudinary.com/documentation/billing_and_plans). Check each service's own pricing page before relying on these numbers; they change.
