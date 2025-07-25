# IGV.js Custom Track API: Guide & Lifecycle

This document provides an overview of the **IGV.js Track API**, covering lifecycle methods, responsibilities, and control flow. It is accompanied by a state diagram showing the typical order of operations in a track’s lifecycle.

---

## 🔧 Track Lifecycle & State Flow

![Track Lifecycle Diagram](A_flowchart_diagram_illustrates_the_lifecycle_of_a.png)

1. **`constructor(config, browser)`**
   - Instantiates the track class with a configuration and reference to the IGV browser instance.
   - Should call `super(config, browser)` to inherit base track behavior.

2. **`init(config)`**
   - Performs setup logic after the constructor.
   - Sets up visual parameters, parsing config options like:
     - `displayMode`
     - `sortMode`, `filterMode`
     - font sizes, row height, etc.

3. **`menuItemList()`**
   - Returns an array of DOM menu items (checkboxes, separators, labels).
   - Used for interactive UI elements such as filter toggles, sort order, display mode.

4. **`getFeatures(chr, bpStart, bpEnd, bpPerPixel)`**
   - Fetches or filters features for the current view window.
   - May return a Promise or array.
   - Features must be assigned `.row` properties via `packFeatures()` for vertical layout.

5. **`computePixelHeight(features)`**
   - Based on the assigned `.row` values in features, computes total track height.
   - Called during layout recalculation.

6. **`draw(options)`**
   - Draws all visible features using a canvas context.
   - Uses:
     - `context`: canvas context
     - `bpStart`, `bpEnd`, `bpPerPixel`: genomic window
     - `features`: features returned from `getFeatures()`

---

## 🔄 Key API Methods in Custom Track

### `packFeatures(features, bpPerPixel, ctx, maxRows, filter)`
- Groups features into display rows.
- Responsible for setting `feature.row`.

### `chainRender(feature, bpStart, bpPerPixel, height, ctx, options)`
- Called by `draw()` to render a single feature.
- Handles drawing:
  - main feature boxes
  - components
  - gaps, sequence glyphs
  - arrows and labels

### `drawSequence(...)`
- Renders aligned sequence based on parsed CIGAR string.
- Distinguishes insertions, deletions, mismatches, and uses per-base rendering if zoomed in.

### `getAlignedSequence(sequence, cigar)`
- Converts sequence and CIGAR into aligned string and position mappings.
- Handles `M`, `I`, `D`, `S`, `H`, `N`, etc.

---

## 📦 Track Configuration Options

| Key                   | Default      | Description |
|----------------------|--------------|-------------|
| `displayMode`         | `"FULL"`     | One of `"FULL"`, `"EXPANDED"`, `"SQUISHED"` |
| `sortMode`            | `"SCORE"`    | `"SCORE"`, `"LENGTH"`, `"NAME"`, `"NONE"` |
| `filterMode`          | `"TOPHITS"`  | `"TOPHITS"` or `"SHOWALL"` |
| `clusterNamedAnnotations` | `true` | Cluster features by name |
| `minZoomForSequences` | `0.1`        | Threshold to enable per-base rendering |
| `showSequences`       | `true`       | Enables rendering letters and CIGAR logic |
| `chevronSpacing`      | `25`         | Spacing between strand arrows |

---

## 🧩 Integration Notes

- `TrackView` calls:
  - `track.computePixelHeight()`
  - `track.draw()`
- Features must be prepared and grouped **before** draw.
- Sequence can be fetched from the browser’s genome backend via `getSequenceInterval(chr, start, end)`.

---

## 📚 References

- **IGV.js source**: [`featureTrack.js`](https://github.com/igvteam/igv.js)
- **Custom track examples**: See `segTrack.js`, `variantTrack.js`, `samTrack.js`
