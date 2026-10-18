# Operations checklist

What's left to run Inkboard well is mostly not code: it needs accounts, money or a decision about when. Each item
says when it matters, what to do, and how to check it worked. The app runs on Render (`render.yaml`) with its data in
MongoDB Atlas.

## Once, after the 2026-10-18 release

- [ ] **Compress the versions saved before then.** New versions are stored compressed (about a fifth of their size);
      older ones stay as they were until this runs. It's optional, since the server reads both, and safe to run while
      the app is up and to stop and run again. With the production `MONGODB_URI` in `server/.env`:
      `npm run compress-versions -w server`. Check: the Atlas dashboard shows the `versions` collection shrinking.

## When it starts to matter

- [ ] **The service sleeps when nobody uses it** (Render's free plan, after 15 minutes). The `Keep alive` workflow
      pings `/health` every 10 minutes, but GitHub runs it late when busy and turns it off after 60 days without a
      push, so someone can still meet a cold start of about a minute. _When:_ people use it for real. _Do:_ move the
      service to a paid Render plan (`plan:` in `render.yaml`) and delete `.github/workflows/keep-alive.yml`, or
      re-enable the workflow under the Actions tab whenever it stops. _Check:_ the Render dashboard shows no sleeps.
- [ ] **Pictures move to Cloudflare R2.** Pictures live in MongoDB (GridFS), which shares Atlas's free 512 MB with
      everything else. _When:_ the database passes about 300 MB in the Atlas dashboard. _Do:_ create the bucket and
      key, set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` on Render, redeploy, then
      run `npm run move-images-to-r2 -w server` once. The full steps are in [image-storage.md](image-storage.md).
      _Check:_ a new upload's entry in `images.files` says `storage: "r2"`.
- [ ] **Emails from a domain of our own.** Verification, invite and reset emails go through Brevo (`BREVO_API_KEY`,
      `EMAIL_FROM`, `EMAIL_FROM_NAME`, set on Render) from an address without a domain of its own, so some land in
      spam. _Do:_ buy a domain, authenticate it in Brevo (SPF, DKIM and DMARC records), set `EMAIL_FROM` to an address
      on it, and point `APP_URL` at the domain if the app moves there. _Check:_ a password reset email arrives in an
      inbox, not spam, with Brevo's checks green.
- [ ] **More than one server.** Each open board lives in one server process's memory (its session, merge state,
      timer, voting, private and classroom mode), so a second instance would split a board between people. One
      instance is fine at today's traffic. _When:_ one instance can't keep up. _Do (code first):_ either route every
      board to one instance (sticky by board id) or move sessions out of process (the Socket.IO Redis adapter plus a
      shared store for open boards); then raise the instance count. _Check:_ two people on different instances see
      each other's changes.

## Keys the people using it bring

- **Draw with AI** and **handwriting to equations** run in each person's browser with their own Anthropic key, kept
  only in that browser. There's no server-side key or allowance to look after. Neither has been tried with a real
  key yet: the first person to do so should check that both work.
