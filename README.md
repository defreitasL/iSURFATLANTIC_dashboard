# iSurfability dashboard

Surf climate along the European Atlantic coast: **19,884 coastal points**, one
every kilometre, from 40 years of IBI wave reanalysis and CERRA winds, and what
two CMIP6 models project for the same beaches.

A folder of static files. No build step, no server code, no API key. Copy it
onto any web server, or open it behind a local one, and it works. It also drops
into a page that already exists: the Embed button writes the iframe, and every
view — measure, period, pathway, horizon, model, language, the open beach —
lives in the URL, so an embedded copy can be pointed at whatever the page is
about.

If the basemap's tile CDN cannot be reached, from behind a proxy or offline,
the map draws the coast on a plain background rather than showing an empty
page. It waits 12 seconds before giving up on a basemap that has errored and 25
before giving up on one that has simply not arrived, because slow is not broken
and a working basemap is not worth throwing away. The data is local; only the
scenery is not.

```bash
python -m http.server 8765
```

Then <http://127.0.0.1:8765>, from inside this folder. It needs a server rather
than a bare file because it fetches its own data; `file://` blocks that.

## What is in here

```
index.html          the page
app.js              all the behaviour, one file, no framework
style.css           all the styling, colours as custom properties
i18n/*.json         every word the page says, one file per language
data/coast.bin      coordinates and every mapped measure, 0.89 MB
data/meta.json      what is in coast.bin, and how to colour it
data/change.bin     what the projections say, 0.78 MB, fetched only if asked
data/series/*.bin   yearly and monthly series, 512 points to a block, 2.5 MB
data/spots.json     the 28 studied beaches
cards/<beach>/      the 448 analysis cards those beaches link to
logo-*.png          the project mark, coloured by day and white at night
```

The data is built by `scripts/build_dashboard_data.py` in the pipeline
repository, which reads 570 GB of forcing that does not live here. It writes
straight into this folder:

```bash
python scripts/build_dashboard_data.py --output /path/to/this/folder/data
```

Everything else follows from that path: the cards are re-themed into
`cards/`, and `index.html` is stamped with the build.

## What the map covers, and what it leaves out

The hindcast runs wherever there is forcing, which is wider than this project.
Four areas are computed but not published: **Great Britain and its isles**, the
**Mediterranean** (the Balearics with it), the African shore of the Strait
around **Tangier**, and the stretch of **Western Sahara** near Tarfaya that
arrived with the Canaries. 11,903 points of 31,787 come out; 19,884 are
published.

Nothing is deleted — the points keep their numbers in the pipeline's
`outputs/`, and the cut is a list of four shapes at the top of
`build_dashboard_data.py`. Widening the scope again is one edit and one
rebuild.

The shapes are not boxes. A box round Britain takes half of Ireland with it,
and a box south of it takes Normandy and Brittany, so Britain is a polygon
whose west side runs down the Irish Sea and whose south side runs down the
middle of the English Channel. The tightest passage is the North Channel, where
Rathlin and the Mull of Kintyre are 17 km apart. The cut is checked against
named places rather than by eye: Dublin, Belfast, Malin Head, Cork, Brittany,
Jersey, Santander and Tarifa stay; Cornwall, Islay, the Isle of Man, Shetland,
Algeciras, Tangier and Palma go; Lanzarote stays while Tarfaya, 90 km across
the water, goes.

## The projections, and how much of them to believe

The Period control swaps the map from what was measured to what two CMIP6
models project, by pathway and horizon. `change.bin` is a second file, fetched
the first time someone asks: it adds most of the first load again, and most
readers open the map to see where the surf is, not where it is going.

Colour carries the change in surfable days. **Confidence is carried by the
fade**, the same channel the hindcast trend map already uses, and full colour
is a claim made only where three things hold at once: the beach has more than
30 surfable days a year to lose, the two models change in the same direction,
and each shift survives a false-discovery correction across the whole map. Pick
one model and the agreement clause drops away — you are reading one model, and
the panel says so.

Each pathway and horizon has its own colour scale. One scale for all six is set
by the loudest case, SSP5-8.5 at the end of the century, and leaves every other
map a flat grey band saying nothing; the legend carries its numbers, so the
change of scale is visible.

Both models are carried, never their average. The finding is that they agree
along the Atlantic facade and part company over the Canaries, where there is
most surf to lose; an average is the one object that would hide that.

Under the legend, a strip splits the summarised coast four ways — loses surf
beyond chance, loses surf within the noise, the models disagree, gains surf —
and it moves with the controls. It is there because the honest headline of this
dataset is not a number but a proportion: at every pathway and horizon except
SSP5-8.5 at 2071–2100, most of the coast sits in the second bucket.

**Full statistics** opens a sheet over the map with all twelve runs at once,
because the map can only ever show one. Four questions in the order a reader
asks them: how much of the coast each run actually claims, how big the change
is, where the two models agree beach by beach, and how it falls by area. All of
it is computed in the browser from `change.bin`.

Clicking a point gives that beach's own version: each model's track across the
three horizons, drawn against a band of its own year-to-year swing. A shift
inside the band is smaller than the difference between a good year and a bad
one, whatever its p-value.

## The cards

A card wears the same page as the map: the same tokens, the same two themes,
and the theme remembered under the same `isurf-theme` key, so a beach opened at
night off a dark map opens dark. The card is drawn once, in daylight, and
carries a patch of the leaves whose colour differs — a few hundred of them,
against forty years of data — rather than a second copy of itself.

A beach has sixteen cards: what it is like now, every pathway set against each
other, and one per model, pathway and horizon. The map opens the first of them,
because the map is showing 1985–2024 and so is that card; the other fifteen are
in the menu each card carries, built from the file names rather than from
sixteen figures read back.

The cards are still English inside their figures. The page around them follows
the map's theme, but the axis titles, panel headings and hover text do not yet
follow its language.

## Four languages, and a glossary

`i18n/{en,es,fr,pt}.json` hold every word the page says: the chrome, the measure
names and what each counts, the sentences the panels build, and the whole of the
glossary. They are fetched like any other data file, with the same build stamp,
and switching language re-renders rather than reloads — a reader who has to find
their beach again has not been handed a translation, they have been handed a new
page. The choice is remembered and travels in the URL, so an embedded copy can be
pinned to one language.

A key the chosen file does not carry falls back to English rather than to
nothing: a half-finished translation should show a few English words, not blanks.

The **Glossary** sheet explains the index, where the waves come from, the
difference between a grid point and a studied beach, and what the map leaves
out; then each measure in plain language, with a histogram of how the published
coast is distributed across it in the map's own colours; then the four phrases
that carry the projections' meaning.

## Why the files carry a version

`meta.json` and `coast.bin` are one object in two files: the chains in the first
index the arrays in the second. A browser that keeps one and refetches the other
does not fail — it draws a coastline through the Gulf of Guinea and reports two
and a half thousand surfable days a year, because the offsets in one file address
a different layout in the other.

So the build stamps `index.html` with a hash of the contents, `app.js` reads that
stamp off its own script URL, and every data file it fetches carries it too. A
cache then holds the whole set or none of it. The stamp changes only when the
contents change, so rebuilding without changing anything leaves the page alone.

As a second line, the page checks on load that `coast.bin` is exactly the size
`meta.json` says and that the chains cover exactly as many points as it claims.
If they disagree it says so on the page and asks for a hard reload, rather than
drawing something that looks like data.

## Why the coast is a line and not dots

The points sit a kilometre apart. Drawn as dots they disappear into a single
pixel at a European zoom and separate into a dotted string up close, and a
reader fairly reads the holes as coast nobody evaluated. A line holds the same
width at every zoom, so the same picture means the same thing however far in
you are.

The coastline the points came from arrives as thousands of separate line
features, most of them holding a single point, so the build walks the points
into chains itself. Two guards keep the walk on one shore: it may not turn more
than 110° in a step, and it may not step onto a point whose beach faces more
than 110° away from the current one. Without the second guard the walk crosses
narrow estuaries and draws line over open water. The result puts 19,679 of the
19,884 points into 950 chains, about 8,900 km of line, with no drawn step
longer than 1.4 km.

## The two kinds of answer

Clicking the coast opens a **coastal grid point**. Clicking a beach marker
opens a **studied beach**, and those are different numbers on purpose.

The grid samples the coastline every kilometre and takes the aspect it finds
there. Around a headland or inside a bay that is not the way the named beach
faces, and the surfability index is sensitive to aspect. Across the 28
Cantabrian beaches the gap between the two tracks the gap in aspect at a
correlation of 0.78, and reaches 135 days a year at Santa Marina, where the
card has the beach facing 66° and the nearest grid point faces 322°. So the
panel says which of the two it is showing and offers the other, rather than
putting one number under the other's name. Where a beach has a card, the card
is the better answer for that beach.

## Reading the trend map

Surfable days cannot fall below zero, so on a coast with almost no surf a trend
can only go up. The map therefore fades any stretch with under five surfable
days a year, along with any slope that cannot be told apart from zero. On the
published coast that floor matters less than it did before the scope was cut —
918 of the 19,884 points average under a day a year — but the reasoning is the
same, and the fade is what keeps a bounded count from reading as good news.
What is left is a real and modest rise: across the published points the first
decade of the record averages 52.7 surfable days a year and the last 63.7.

## Embedding it

Every view has a URL. The **Share** button copies the link and **Embed** copies
an iframe for it.

```html
<iframe src="https://example.org/isurfability/#m=mean_days_per_year&l=es&z=8&c=43.45,-3.80"
        width="100%" height="640" style="border:0" loading="lazy"
        title="iSurfability"></iframe>
```

The hash carries the state: `m` the measure, `l` the language, `z` the zoom,
`c` the centre as `lat,lon`, `p` an open coastal point by its id, `b` an open
beach by its slug, and in projections mode `pd`, `pw`, `hz` and `md` for the
period, pathway, horizon and model. So a page elsewhere on the site can link
straight to the beach it is about, in the language that page is written in.

The bar gives way in stages as the frame narrows, because this is meant to sit
in somebody else's column: the strapline goes first, then the width of the
search, then Share and Embed, then the search itself. The glossary, the
statistics, the language and the theme survive to the narrowest width, because
they are how the map is read.

## Changing how it looks

Every colour is a custom property on `:root` in `style.css`, with a dark set
under `:root[data-theme="dark"]`. Change `--accent` and the whole page follows.
The two basemaps are the `BASEMAPS` constant at the top of `app.js`; swap in
any MapLibre style URL. The colour ramps are `PALETTES` just below it, keyed by
the palette each measure names in `meta.json`.

## Weight

`coast.bin` is 0.89 MB and is fetched once; it holds every measure, so changing
the measure recolours all 19,884 points in a millisecond or two with no network
at all. The series are 2.5 MB in total and are fetched one block at a time,
only when someone opens a point, so the first view never waits for them. The
projections are another 0.78 MB, fetched only if someone asks for them. Serve
the folder with gzip or brotli on, which roughly halves the text.

---

**iSurfability** · iSURFATLANTIC, IHCantabria
