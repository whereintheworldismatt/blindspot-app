# Blindspot

A real-life GeoGuessr for car rides. One person drives (blindfolded passengers),
drops everyone off, and the group guesses where they are on a map.

## Status

This is the in-progress prototype. Currently uses an in-memory "mock room"
for local testing - real cross-phone sync via Firebase is the next step.

## Local development

```bash
npm install
npm run dev
```

Open the printed local URL. Note: GPS (`navigator.geolocation`) requires HTTPS
or `localhost` - it won't work over plain `http://<lan-ip>` if you try to test
on your phone over your local network. Use the "Skip GPS (use demo location)"
button for local testing, or deploy to test real GPS.

## Build

```bash
npm run build
```

Outputs to `dist/`.

## Deploy (Cloudflare Pages)

1. Push this project to a GitHub repo (can be separate from your Bevelhaus repo)
2. In the Cloudflare dashboard, create a new Pages project and connect the repo
3. Build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Deploy - you'll get a `https://<project>.pages.dev` URL

Once deployed, share the URL + a room code with friends to play.

## Roadmap

- [x] Core game loop (driver rotation, GPS capture, pin-drop guessing, scoring)
- [x] Opt-in driver rotation / single-driver mode
- [x] Configurable round count
- [ ] Real-time sync via Firebase Realtime Database
- [ ] Real map (Leaflet/OSM) for guessing and reveal
