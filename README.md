# Social Banner Rotator for StreamElements

A responsive social banner overlay for Twitch, Discord, YouTube, X/Twitter, Kick, TikTok, Patreon, Instagram, and Bluesky.

## Install

Create a StreamElements **Custom Widget**, then copy each repository file into its matching editor tab:

- `SocialBannersRotate.html` → HTML
- `SocialBannersRotate.css` → CSS
- `SocialBannersRotate.js` → JS
- `SocialBannersRotate.fields` → FIELDS

## Banner modes

Choose one global **Banner / Background Type** for all enabled socials. Eight generated themes require no artwork and automatically apply the current platform color, high-contrast text, safe padding, responsive sizing, and an optional platform SVG logo. Choose **Use My Uploaded Banner Images** to retain the original per-slot artwork workflow.

A social is included when its handle field is non-empty. Long handles safely shrink with the overlay viewport and can wrap rather than crossing the card edge.

## Activation and preview

- **Auto Rotate + Chat Command** (default): cycles on a timer and accepts the configured command.
- **Auto Rotate Only**: ignores chat commands.
- **Chat Command Only**: remains hidden until an authorized command is received.
- **Preview Next Banner**: displays the next configured item once, making theme and animation checks quick in the StreamElements editor.

The existing Twitch/YouTube StreamElements message support and direct Kick chat option remain available. Kick username resolution can be browser/Cloudflare dependent; supplying a numeric chatroom ID avoids that lookup.
