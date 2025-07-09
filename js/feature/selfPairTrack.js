import FeatureTrack from "./featureTrack.js";

/**
 * SelfPairTrack is a specialized FeatureTrack for visualizing self-alignment pairs
 * with two rectangular box glyphs (each with a triangular edge and a vertical edge)
 * joined by a dashed arc. Supports both right/left ("-") and right/right ("+") orientations.
 * 
 * Two data encoding corrections are enforced:
 *  1. If the primary or secondary range is out of order (start > end), they're swapped.
 *  2. If the user puts the ranges such that pstart > pend or sstart > send, they're corrected.
 */
class SelfPairTrack extends FeatureTrack {

    constructor(config, browser) {
        super(config, browser);
    }

    init(config) {
        super.init(config);
        this.boxFontHeight = 10;
        this.boxHeight = this.boxFontHeight + 6; // Slightly more padding for triangle
        this.expandedRowHeight = config.expandedRowHeight || this.boxHeight + 12;
        this.squishedRowHeight = config.squishedRowHeight || 16;
        this.margin = config.margin || 8;
        this.arcStroke = config.arcStroke || "#666";
        this.boxColor = config.boxColor || "#1E90FF";
        this.dashArray = [4, 4];
    }

    /** 
     * Normalize the feature to fix encoding problems:
     * - Ensures pstart <= pend, sstart <= send
     * - If pstart/pend are reversed, swap
     * - If sstart/send are reversed, swap
     * - If user encodes the primary/secondary ranges out of order (e.g., pstart > sstart and pstart should be the lower), just keep the fields as is, but always draw so leftmost box is left.
     */
    static normalizeFeature(feature) {
        // Defensive copy (not strictly necessary, but safe)
        // Mutates the feature in-place for ease of use
        if (feature.pstart > feature.pend) {
            [feature.pstart, feature.pend] = [feature.pend, feature.pstart];
        }
        if (feature.sstart > feature.send) {
            [feature.sstart, feature.send] = [feature.send, feature.sstart];
        }
    }

    packFeatures(features, bpPerPixel, ctx, maxRows, filter) {
        maxRows = maxRows || 1000;
        if (!features || features.length === 0) return;
        const chrFeatureMap = {}, chrs = [];
        for (const feature of features) {
            if (filter && !filter(feature)) {
                feature.row = undefined;
            } else {
                const chr = feature.chr;
                if (!chrFeatureMap[chr]) {
                    chrFeatureMap[chr] = [];
                    chrs.push(chr);
                }
                chrFeatureMap[chr].push(feature);
            }
        }
        for (const chr of chrs) {
           this.pack(chrFeatureMap[chr], bpPerPixel, maxRows, ctx);
        }
    }

    pack(featureList, bpPerPixel, maxRows) {
        maxRows = maxRows || Number.MAX_SAFE_INTEGER
        let rows = []
        featureList.sort(function (a, b) {
            return a.start - b.start
        })
        rows.push(-1000)
        for (let feature of featureList) {
            let r = 0
            const len = Math.min(rows.length, maxRows)
            for (r = 0; r < len; r++) {
                if (feature.start > rows[r]) {
                    feature.row = r
                    rows[r] = feature.end
                    break
                }
            }
            feature.row = r
            rows[r] = feature.end
        }
    }

    async getFeatures(chr, bpStart, bpEnd, bpPerPixel) {
        this.packFeatures(this.config.features, bpPerPixel);
        return this.config.features || [];
    }

    computePixelHeight(features) {
        let maxRow = 0;
        if (features && typeof features.forEach === "function") {
            for (const feature of features) {
                if (feature.row !== undefined && feature.row > maxRow) {
                    maxRow = feature.row;
                }
            }
        }
        return this.margin + (maxRow + 1) * this.expandedRowHeight;
    }

    // MODIFIED: Helper to check for overlap between two intervals
    static intervalsOverlap(a1, a2, b1, b2) {
        return Math.max(a1, b1) < Math.min(a2, b2);
    }

    // MODIFIED: Helper to create a diagonal-pattern canvas fill
    static getDiagonalPattern(ctx) {
        const size = 6;
        const patternCanvas = document.createElement("canvas");
        patternCanvas.width = size;
        patternCanvas.height = size;
        const pctx = patternCanvas.getContext("2d");
        pctx.strokeStyle = "black";
        pctx.lineWidth = 1;
        pctx.beginPath();
        pctx.moveTo(0, size);
        pctx.lineTo(size, 0);
        pctx.stroke();
        return ctx.createPattern(patternCanvas, "repeat");
    }

    /**
     * Draw a single selfpair feature: two boxes with triangle edges, connected by a dashed arc.
     * @param {Object} feature - Selfpair feature.
     * @param {number} bpStart - Start base coordinate.
     * @param {number} bpPerPixel - Bases per pixel.
     * @param {number} pixelHeight - Pixel height of the track.
     * @param {CanvasRenderingContext2D} ctx - 2D canvas context.
     * @param {Object} options - Drawing options.
     */
    selfpairRender(feature, bpStart, bpPerPixel, pixelHeight, ctx, options) {
        ctx.save();
        try {
            const pixelTop = options.pixelTop;
            const hBox = this.boxHeight;
            const yBox = pixelTop + 2;

            // Normalize feature to correct start/end order
            SelfPairTrack.normalizeFeature(feature);

            // Define primary and secondary rects
            const primStart = feature.pstart, primEnd = feature.pend;
            const secStart = feature.sstart, secEnd = feature.send;
            const orient = feature.strand || "+";

            const bp2px = bp => (bp - bpStart) / bpPerPixel;

            // Get pixel coordinates
            const pX1 = bp2px(primStart);
            const pX2 = bp2px(primEnd);
            const sX1 = bp2px(secStart);
            const sX2 = bp2px(secEnd);

            // Check if intervals overlap (in bp space, not pixel space)
            const overlap = SelfPairTrack.intervalsOverlap(primStart, primEnd, secStart, secEnd);

            // Decide which box is "left" and which is "right"
            let leftBox = null, rightBox = null;
            if (pX1 < sX1) {
                leftBox = { x1: pX1, x2: pX2, orient: "right" };
                rightBox = { x1: sX1, x2: sX2, orient: orient === "+" ? "right" : "left" };
            } else {
                leftBox = { x1: sX1, x2: sX2, orient: "right" };
                rightBox = { x1: pX1, x2: pX2, orient: orient === "+" ? "right" : "left" };
            }

            // CHANGED: Use per-feature color if present, otherwise default
            const leftBoxColor = feature.color || this.boxColor;
            const rightBoxColor = feature.color || this.boxColor;

            // MODIFIED: Draw the two boxes
            if (overlap) {
                // Draw both as vertical rectangles (no triangle)
                this.drawRectBox(ctx, leftBox, yBox, hBox, leftBoxColor);
                this.drawRectBox(ctx, rightBox, yBox, hBox, rightBoxColor);

                // Compute overlap in pixel space
                const overlapStart = Math.max(pX1, sX1);
                const overlapEnd = Math.min(pX2, sX2);

                if (overlapEnd > overlapStart) {
                    // Fill overlapping area with diagonal pattern
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(overlapStart, yBox, overlapEnd - overlapStart, hBox);
                    ctx.clip();
                    ctx.fillStyle = SelfPairTrack.getDiagonalPattern(ctx);
                    ctx.fillRect(overlapStart, yBox, overlapEnd - overlapStart, hBox);
                    ctx.restore();
                }
            } else {
                // Draw as triangles + rectangles
                this.drawTriBox(ctx, leftBox, yBox, hBox, leftBoxColor, bpPerPixel);
                this.drawTriBox(ctx, rightBox, yBox, hBox, rightBoxColor, bpPerPixel);

                // Draw dashed arc connecting the two boxes
                const arcY0 = yBox + hBox / 2;
                const arcYPeak = yBox - hBox * 0.7;
                const arcStartX = leftBox.x2;
                const arcEndX = rightBox.x1;

                ctx.strokeStyle = this.arcStroke;
                ctx.setLineDash(this.dashArray);

                // Use a quadratic curve to create the arc
                ctx.beginPath();
                ctx.moveTo(arcStartX, arcY0);
                ctx.quadraticCurveTo(
                    (arcStartX + arcEndX) / 2, arcYPeak,
                    arcEndX, arcY0
                );
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Draw optional labels
            ctx.font = "10px sans-serif";
            ctx.fillStyle = "#222";
            if (feature.name) {
                const centerX = (leftBox.x1 + rightBox.x2) / 2;
                ctx.textAlign = "center";
                ctx.fillText(feature.name, centerX, yBox + hBox + 12);
            }
        } finally {
            ctx.restore();
        }
    }

    /**
     * Draws a rectangle with a single triangular edge (for the selfpair glyph).
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} box - {x1, x2, orient("left"/"right")}
     * @param {number} yBox - Top Y coordinate
     * @param {number} hBox - Height of the box
     * @param {string} boxColor
     * @param {number} bpPerPixel
     */
    drawTriBox(ctx, box, yBox, hBox, boxColor, bpPerPixel) {
        ctx.save();
        const { x1, x2, orient } = box;
        const triWidth = Math.max(10, Math.min(0, (x2 - x1)/bpPerPixel ));
        ctx.beginPath();
        if (orient === "left") {
            // Left triangle, right vertical
            ctx.moveTo(x2, yBox);                // right top
            ctx.lineTo(x1 + triWidth, yBox);     // triangle base top
            ctx.lineTo(x1, yBox + hBox / 2);     // triangle tip
            ctx.lineTo(x1 + triWidth, yBox + hBox); // triangle base bottom
            ctx.lineTo(x2, yBox + hBox);         // right bottom
            ctx.closePath();
        } else {
            // Right triangle, left vertical
            ctx.moveTo(x1, yBox);                // left top
            ctx.lineTo(x2 - triWidth, yBox);     // triangle base top
            ctx.lineTo(x2, yBox + hBox / 2);     // triangle tip
            ctx.lineTo(x2 - triWidth, yBox + hBox); // triangle base bottom
            ctx.lineTo(x1, yBox + hBox);         // left bottom
            ctx.closePath();
        }
        ctx.fillStyle = boxColor;
        ctx.fill();
        ctx.restore();
    }

    // MODIFIED: Draws a vertical rectangle box (no triangle)
    drawRectBox(ctx, box, yBox, hBox, boxColor) {
        ctx.save();
        const { x1, x2 } = box;
        ctx.beginPath();
        ctx.rect(x1, yBox, x2 - x1, hBox);
        ctx.closePath();
        ctx.fillStyle = boxColor;
        ctx.fill();
        ctx.restore();
    }

    draw(options) {
        const {
            context, pixelWidth, pixelHeight, bpPerPixel, bpStart, bpEnd,
            pixelTop, features
        } = options;

        const ctx = context;
        this.packFeatures(features, bpPerPixel, ctx);

        for (const f of features) {
            if (f.row !== undefined) {
                const y = f.row * (this.expandedRowHeight || 24);
                this.selfpairRender(f, bpStart, bpPerPixel, pixelHeight, ctx, {
                    pixelTop: y,
                    bpPerPixel,
                    bpEnd
                });
            }
        }
    }
}

export default SelfPairTrack;
