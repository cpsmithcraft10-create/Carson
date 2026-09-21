# The website

The public side of Custom Outdoor Design: what the work looks like, who does
it, how an estimate happens, and the form that brings a job in. Plain HTML,
one stylesheet, one script, no build step and nothing to install. Open
`index.html` in a browser and it is the whole site.

The design runs an evening on purpose. It opens at last light, because that
is the hour landscape lighting exists in, and stays dark through the parts a
customer looks at. It breaks to daylight for the parts they have to read and
act on — about us, how it works, the form, the questions — and the drawings
in those sections are the real thing: a zone plan, a lighting elevation, a
French drain section.

## Before it goes live

Everything below is written into the page as a placeholder. While any of it
is still there, leave the draft bar on — it lists them across the top of the
page so nothing ships half-filled.

Search `index.html` for **PLACEHOLDER** to find each one:

| What | Where it appears |
| --- | --- |
| Phone number | header, hero, estimates, footer, the phone bar, and the schema block at the bottom |
| Email | estimates fallback, footer, schema block — also `FALLBACK_EMAIL` in `js/site.js` |
| Town, and the towns you cover | hero eyebrow, footer, schema block |
| The year he started | hero eyebrow, about |
| Licence number | about, footer |
| Warranty terms | about, and the last FAQ answer |
| Lead times | the "How soon can you come out" answer |
| His name and one line about him | the caption under the portrait |

The fastest way is a find-and-replace on `(555) 012-3456`, `office@example.com`
and `Springfield`.

When they are all real, open `js/site.js` and set:

```js
var DRAFT = false;
```

and the bar across the top disappears.

## Photographs

The site is built to run without a single photo and to fill in the moment
there are some. Drop files into `site/photos/` with these names and they
appear on their own:

```
photos/01.jpg   front of a house at dusk, facade lit
photos/02.jpg   a new sprinkler system going in
photos/03.jpg   an open French drain trench
photos/04.jpg   a lit walkway after dark
photos/05.jpg   sprinklers running early morning
photos/06.jpg   a side yard that used to hold water
photos/owner.jpg   him, on a job
```

Any frame with no file behind it stays an empty frame and says what belongs
there. Shoot the lighting ones about twenty minutes after sunset — while
there is still some blue in the sky — not at midnight. Wide, from where
somebody would stand in the driveway. Then change the caption under each one
in `index.html` to say what that job actually was.

Save them at around 1600px wide so a phone on one bar still loads them.

## Where the estimate form goes

The form posts to `/api/estimate`, which the crew app answers. Requests land
in the office screen under **Estimates**, with a count on the tab until
somebody has rung back, and a button to put them straight on the customer
list.

If the site is hosted somewhere separate from the app — a static host, a
different subdomain — open `js/site.js` and point it at the app:

```js
var ESTIMATE_ENDPOINT = 'https://app.your-domain.com/api/estimate';
```

and set `SITE_ORIGIN` on the app's server to this site's address, so the
browser is told which site is allowed to post:

```bash
SITE_ORIGIN=https://customoutdoordesign.com npm start
```

If the form cannot reach the server at all, it does not lose the job: it
shows the phone number and offers to send the same details as an email
instead.

## Putting it online

It is static files, so anything will serve it — Netlify, Cloudflare Pages,
S3, or the same box the crew app runs on. Two things worth doing:

- **Point the domain at this, not at the app.** The public site belongs on
  `customoutdoordesign.com`; the crew app belongs somewhere like
  `app.customoutdoordesign.com`. The footer link marked *Crew & office sign
  in* is what joins them — set its `href` to wherever the app ends up.
- **Fill in the share image.** `og:image` near the top of `index.html`
  wants the full address once there is a domain, so the link looks right
  when somebody texts it.

To serve it from the crew app's own box instead, copy this folder into
`public/site/` and it answers at `/site/`.

## Being found

The page already carries a `LocalBusiness` block at the bottom that tells
Google the trade, the hours and the towns — fill in the real ones. Two things
matter more than anything on the page itself: a Google Business Profile with
the same name, number and address as this site, and photographs of real jobs.

## Files

```
index.html       the whole site — every section in order
css/site.css     the design: night, daylight, and the drawings
js/site.js       the draft bar, the sky, the photo slots, the form
photos/          drop real job photographs in here
icons/           home-screen and tab icons, same mark as the app
```
