# A Hundred Hands · Post approvals

A small web app where Krayons Digital and A Hundred Hands (AHH) review and approve Instagram posts.

**How a post moves**

1. **Outline: Krayons.** Raj approves the outline or sends it back with a note.
2. **Outline: AHH.** Vikram approves it or asks for changes. AHH only sees posts after Raj has approved the outline.
3. **In production.** Krayons adds the caption and uploads the reel or image.
4. **Post: Krayons**, then **Post: AHH.** The same two approvals happen again, this time on the finished post.
5. **Approved.** The post is ready to schedule in Meta Business Suite. Krayons marks it **Scheduled** once it's set up there.

Only AHH approvers can tick **Boost this post**. Every decision is kept in the post's history, with who made it and when.

**Roles**

| Role | Who | Can do |
|---|---|---|
| admin | Raj (Krayons) | Approve first, edit posts, add people, create password links, import the calendar |
| editor | Krayons team | Edit posts, upload creatives, submit for approval, mark scheduled |
| approver | Vikram (AHH) | Approve or send back, set "boost this" |
| viewer | Others at AHH | See posts after Krayons approves the outline, and comment |

It runs on Cloudflare Pages (the site and API), D1 (the database) and R2 (uploaded creatives). Nothing needs building: the `public/` folder is served as it is.

---

## One-time set-up in Cloudflare (Krayons account)

These steps are done once, while signed in to the Krayons Cloudflare account.

### 1. Database (D1)
1. Go to **Storage & Databases → D1 SQL Database → Create**.
2. Name it `ahh-approvals` and create it.
3. Open it and copy the **Database ID**. Send it to Claude, who puts it in `wrangler.toml` and pushes the change.
4. Open the **Console** tab. Paste the whole contents of `migrations/0001_init.sql` and run it. This creates the tables and the users Raj, Krayons team and Vikram.

### 2. File storage (R2)
1. Go to **Storage & Databases → R2 Object Storage**. Cloudflare may ask for a payment method before R2 is switched on, even on the free tier.
2. Create a bucket named `ahh-approvals-media`, with location **Automatic** and the default storage class **Standard**.

### 3. The site (Pages)
1. Go to **Workers & Pages → Create → Pages → Connect to Git**.
2. Choose the GitHub repository `iamrajeshrajan/ahh-approvals`.
3. Set the build options:
   - Framework preset: **None**
   - Build command: leave empty
   - Build output directory: `public`
4. Click **Save and Deploy**. The database and file storage connect automatically from `wrangler.toml`.

### 4. The setup code (a secret only Raj knows)
1. In the Pages project, go to **Settings → Variables and Secrets → Add**.
2. Type: **Secret**. Name: `ADMIN_SETUP_CODE`. Value: any phrase you choose.
3. Redeploy: **Deployments → latest → Retry deployment**.

### 5. Address: ahh.krayonsdigital.com
1. In the Pages project, go to **Custom domains → Set up a custom domain** and enter `ahh.krayonsdigital.com`.
2. If krayonsdigital.com's DNS is managed by Cloudflare, the record is added for you.
3. If it isn't, add a **CNAME** record named `ahh` that points to the project's `*.pages.dev` address, at your DNS provider.

### 6. First sign-in
1. Open `https://ahh.krayonsdigital.com/#/setup`, enter the setup code and choose Raj's password. This works only once.
2. Sign in as **raj**.
3. Go to **People**. For Krayons team and Vikram, click **Create password link** and send each person their link. Each link works once and expires after 7 days.
4. Add anyone else at AHH as **AHH · view only**, and create their link the same way.
5. Go to **Import** and upload `seed/ahh_calendar_18nov-14feb.json`. This adds 199 posts (56 feed posts and 143 stories, 18 Nov 2026 to 14 Feb 2027) at the "Outline: Krayons" stage.

---

## Running it locally (for Claude or a developer)

```
npm install
echo "ADMIN_SETUP_CODE=local-test-code" > .dev.vars
npx wrangler d1 migrations apply ahh-approvals --local
npx wrangler pages dev public --port 8788
```

## Files

- `public/`: the site (`index.html`, `app.js`, `app.css`, logos)
- `functions/api/[[path]].js`: the API (sign-in, posts, approvals, uploads, people)
- `migrations/0001_init.sql`: database tables and starting users
- `seed/ahh_calendar_18nov-14feb.json`: the Essentials calendar, ready to import
