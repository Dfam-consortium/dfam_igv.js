import FeatureTrack from "./featureTrack.js";

/**
 * ChainTrack is a specialized FeatureTrack for visualizing chain alignment features,
 * supporting sequence rendering, gap/extension arms, and feature packing by rows.
 * Optionally, it can try to cluster identically named annotations onto the same or adjacent rows.
 */
class ChainTrack extends FeatureTrack {

    /**
     * Construct a ChainTrack.
     * @param {Object} config - Configuration object.
     * @param {Object} browser - Browser instance.
     */
    constructor(config, browser) {
        super(config, browser);
    }

    /**
     * Initialize the track with configuration.
     * Adds "clusterNamedAnnotations" to config.
     * @param {Object} config - Configuration object.
     */
    init(config) {
        super.init(config);
        // -- Sequence display configuration --
        this.showSequences = config.showSequences !== undefined ? config.showSequences : true;
        this.minZoomForSequences = config.minZoomForSequences ?? 0.1;
        this.sequenceFont = config.sequenceFont || "10px monospace";
        this.insertionFont = config.insertionFont || "10px monospace";
        this.smallLabelFont = config.smallLabelFont || "8px sans-serif";
        this.labelFont = config.labelFont || "10px sans-serif";

        // Calculate font heights from font size strings
        this.sequenceFontHeight = parseInt(this.sequenceFont.match(/(\d+(?:\.\d+)?)px/)[1]);
        this.smallLabelFontHeight = parseInt(this.smallLabelFont.match(/(\d+(?:\.\d+)?)px/)[1]);
        this.labelFontHeight = parseInt(this.labelFont.match(/(\d+(?:\.\d+)?)px/)[1]);
        this.insertionFontHeight = parseInt(this.insertionFont.match(/(\d+(?:\.\d+)?)px/)[1]);

        this.boxFontHeight = Math.max(this.sequenceFontHeight, this.labelFontHeight);
        this.boxHeight = this.boxFontHeight + 4; // 4px padding

        // Expanded row height: ensure enough space for all labels and boxes
        const minRowHeight = 2 + this.smallLabelFontHeight + 2 + this.boxHeight + 2 + this.labelFontHeight + 2;
        this.expandedRowHeight = Math.max(config.expandedRowHeight ?? minRowHeight, minRowHeight);

        // Squished row height for "squished" display mode
        this.squishedRowHeight = config.squishedRowHeight || 14;
        this.margin = config.margin || 6;

        // Chevron (arrowhead) spacing in component rectangles (default: 25px)
        this.chevronSpacing = config.chevronSpacing || 25;

        // Optional: cluster identically named features ("annotations") in packing
        this.clusterNamedAnnotations = config.clusterNamedAnnotations || true;

        // Debug/log expanded row height
        console.debug("ChainTrack: expandedRowHeight =", this.expandedRowHeight);
        if (this.clusterNamedAnnotations) {
            console.debug("ChainTrack: feature packing will cluster identically named annotations");
        }
    }

    /**
     * Return feature list for the given region.
     * @param {string} chr - Chromosome.
     * @param {number} bpStart - Start base pair.
     * @param {number} bpEnd - End base pair.
     * @returns {Promise<Array>} List of features.
     */
    async getFeatures(chr, bpStart, bpEnd, bpPerPixel) {
        // TODO: load features for region; for now, return all from config.
        // NOTE: IGV.js initially sets the height of a track to a pre-configured
        //       value or calls the track's computePixelHeight method (if defined)
        //       to obtain the height.  Unfortunately in some cases the height
        //       might depend on packing.
        //       it does not provide a graphics context for 
        this.packFeatures(this.config.features, bpPerPixel);
        return this.config.features || [];
    }

    /**
     * Compute the pixel height required for drawing the given features.
     * @param {Array} features - List of features.
     * @returns {number} Pixel height.
     */
    computePixelHeight(features) {
        if (this.displayMode === "COLLAPSED") {
            return this.margin + this.expandedRowHeight;
        } else {
            let maxRow = 0;
            if (features && typeof features.forEach === "function") {
                for (const feature of features) {
                    if (feature.row !== undefined && feature.row > maxRow) {
                        maxRow = feature.row;
                    }
                }
            }
            for (const feature of features) {
              if ( feature.row !== undefined && feature.row > maxRow ) {
                maxRow = feature.row;
              }
            }

            const baseHeight = this.margin + (maxRow + 1) *
                (this.displayMode === "SQUISHED" ? this.squishedRowHeight : this.expandedRowHeight);

            return baseHeight;
        }
    }

    /**
     * Assigns features to rows to avoid overlap. Groups by chromosome.
     * Optionally, cluster identically named annotations based on config.
     * @param {CanvasRenderingContext2D} ctx - 2D canvas context.
     * @param {Array} features - List of features.
     * @param {number} bpPerPixel - Bases per pixel.
     * @param {number} maxRows - Maximum rows allowed.
     * @param {Function} filter - Optional feature filter function.
     */
    packFeatures(features, bpPerPixel, ctx, maxRows, filter) {
        maxRows = maxRows || 1000;
        if (!features || features.length === 0) return;

        // Group features by chromosome
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

        // Pack each chromosome's features into rows
        for (const chr of chrs) {
            if (this.clusterNamedAnnotations) {
                this.packClustered(chrFeatureMap[chr], bpPerPixel, maxRows, ctx);
            } else {
                this.pack(chrFeatureMap[chr], bpPerPixel, maxRows, ctx);
            }
        }
    }

  /**
 * Packs features by clustering identically named annotations on the same or adjacent rows.
 * Features with the same name will be packed together as much as possible.
 * @param {Array} featureList - Features to pack.
 * @param {number} bpPerPixel - Bases per pixel.
 * @param {number} maxRows - Maximum rows.
 * @param {CanvasRenderingContext2D} ctx - 2D canvas context.
 */
 packClustered(featureList, bpPerPixel, maxRows, ctx) {
    const extensionLen = 30;
    maxRows = maxRows || Number.MAX_SAFE_INTEGER;

    // Group features by name (undefined/null names go in their own group)
    const nameMap = new Map();
    for (const feature of featureList) {
        const name = feature.name || "__no_name__";
        if (!nameMap.has(name)) nameMap.set(name, []);
        nameMap.get(name).push(feature);
    }

    // We'll keep an array of "row end positions" like in the greedy algorithm
    const rows = [];

    // Estimate extension label width
    let extensionLabelWidth = 40;
    if ( ctx !== undefined ) {
      extensionLabelWidth = ctx.measureText(" 0000 bp ").width;
    }
    // ...perhaps estimate the width unless we are handed a context 

    // For each name group, pack its features using the greedy interval packing algorithm
    for (const group of nameMap.values()) {
        // Sort features in group by start, as for greedy packing
        group.sort((a, b) => a.start - b.start);

        for (const feature of group) {
            // Compute visual start/end with extensions
            let visualStart = feature.start, visualEnd = feature.end;
            if ((feature.end - feature.start) / bpPerPixel > 3 * extensionLen) {
                const extraBp = Math.ceil((2 * (extensionLen + extensionLabelWidth)) * bpPerPixel);
                visualStart = feature.start - extraBp;
                visualEnd = feature.end + extraBp;
            }

            // Try to fit this feature into the lowest available row
            let placed = false;
            for (let r = 0; r < Math.min(rows.length, maxRows); r++) {
                if (visualStart >= (rows[r] || -1000)) {
                    feature.row = r;
                    rows[r] = visualEnd;
                    placed = true;
                    break;
                }
            }
            // If not placed, create a new row (if allowed)
            if (!placed && rows.length < maxRows) {
                feature.row = rows.length;
                rows.push(visualEnd);
            }
            // If maxRows is reached and can't be placed, feature.row will be undefined (optional: handle as needed)
        }
    }
}
    /**
     * Packs features by clustering identically named annotations on the same or adjacent rows.
     * Features with the same name will be packed together as much as possible.
     * @param {Array} featureList - Features to pack.
     * @param {number} bpPerPixel - Bases per pixel.
     * @param {number} maxRows - Maximum rows.
     * @param {CanvasRenderingContext2D} ctx - 2D canvas context.
     */
    packClusteredOld(featureList, bpPerPixel, maxRows, ctx) {
        const extensionLen = 30;
        maxRows = maxRows || Number.MAX_SAFE_INTEGER;

        // Group features by name (undefined/null names go in their own group)
        const nameMap = new Map();
        for (const feature of featureList) {
            const name = feature.name || "__no_name__";
            if (!nameMap.has(name)) nameMap.set(name, []);
            nameMap.get(name).push(feature);
        }

        // We'll keep an array of "row end positions" like in the greedy algorithm
        const rows = [];
        rows.push(-1000);

        // Estimate extension label width
        const extensionLabelWidth = ctx.measureText(" 0000 bp ").width;

        // For each name group, pack its features as a block, keeping them close in rows
        let rowIndex = 0;
        for (const group of nameMap.values()) {
            // Sort features in group by start, as for greedy packing
            group.sort((a, b) => a.start - b.start);

            // Find the lowest row at which these features can be packed contiguously
            let blockRow = 0;
            let found = false;
            while (!found && blockRow < maxRows) {
                // Copy the current rows array for this block candidate
                const tempRows = rows.slice();
                let valid = true;
                for (const feature of group) {
                    // Compute visual start/end with extensions
                    let visualStart = feature.start, visualEnd = feature.end;
                    if ((feature.end - feature.start) / bpPerPixel > 3 * extensionLen) {
                        const extraBp = Math.ceil((2 * (extensionLen + extensionLabelWidth)) * bpPerPixel);
                        visualStart = feature.start - extraBp;
                        visualEnd = feature.end + extraBp;
                    }
                    // Try to fit this feature in a row within [blockRow, blockRow+group.length)
                    let placed = false;
                    for (let r = blockRow; r < blockRow + group.length && r < maxRows; r++) {
                        if (visualStart >= (tempRows[r] || -1000)) {
                            tempRows[r] = visualEnd;
                            placed = true;
                            break;
                        }
                    }
                    if (!placed) {
                        valid = false;
                        break;
                    }
                }
                if (valid) {
                    found = true;
                    // Place all features for real, using the selected rows
                    for (const feature of group) {
                        let visualStart = feature.start, visualEnd = feature.end;
                        if ((feature.end - feature.start) / bpPerPixel > 3 * extensionLen) {
                            const extraBp = Math.ceil((2 * (extensionLen + extensionLabelWidth)) * bpPerPixel);
                            visualStart = feature.start - extraBp;
                            visualEnd = feature.end + extraBp;
                        }
                        for (let r = blockRow; r < blockRow + group.length && r < maxRows; r++) {
                            if (visualStart >= (rows[r] || -1000)) {
                                feature.row = r;
                                rows[r] = visualEnd;
                                break;
                            }
                        }
                    }
                    rowIndex = Math.max(rowIndex, blockRow + group.length);
                } else {
                    blockRow++;
                }
            }
            // If no valid block found, fall back to greedy for remaining features
            if (!found) {
                for (const feature of group) {
                    let r = 0;
                    let visualStart = feature.start, visualEnd = feature.end;
                    if ((feature.end - feature.start) / bpPerPixel > 3 * extensionLen) {
                        const extraBp = Math.ceil((2 * (extensionLen + extensionLabelWidth)) * bpPerPixel);
                        visualStart = feature.start - extraBp;
                        visualEnd = feature.end + extraBp;
                    }
                    for (; r < rows.length && r < maxRows; r++) {
                        if (visualStart >= (rows[r] || -1000)) {
                            feature.row = r;
                            rows[r] = visualEnd;
                            break;
                        }
                    }
                    if (r === rows.length && r < maxRows) {
                        feature.row = r;
                        rows[r] = visualEnd;
                    }
                }
            }
        }
    }

    /**
     * Packs features in featureList into rows to avoid overlap, using a greedy algorithm.
     * @param {Array} featureList - Features to pack.
     * @param {number} bpPerPixel - Bases per pixel.
     * @param {number} maxRows - Maximum rows.
     * @param {CanvasRenderingContext2D} ctx - 2D canvas context.
     */
    pack(featureList, bpPerPixel, maxRows, ctx) {
        const extensionLen = 30;
        maxRows = maxRows || Number.MAX_SAFE_INTEGER;
        const rows = [];

        featureList.sort((a, b) => a.start - b.start);
        rows.push(-1000);

        // Estimate width of extension label
        const extensionLabelWidth = ctx.measureText(" 0000 bp ").width;

        for (const feature of featureList) {
            let r = 0;
            const len = Math.min(rows.length, maxRows);

            // Account for extension arms if visible
            let visualStart = feature.start, visualEnd = feature.end;
            if ((feature.end - feature.start) / bpPerPixel > 3 * extensionLen) {
                const extraBp = Math.ceil((2 * (extensionLen + extensionLabelWidth)) * bpPerPixel);
                visualStart = feature.start - extraBp;
                visualEnd = feature.end + extraBp;
            }

            for (r = 0; r < len; r++) {
                if (visualStart >= rows[r]) {
                    feature.row = r;
                    rows[r] = visualEnd;
                    break;
                }
            }
            if (r === len && r < maxRows) {
                feature.row = r;
                rows[r] = visualEnd;
            }
        }
    }

    /**
     * Parse a CIGAR string into an array of operations.
     * @param {string} cigar - CIGAR string.
     * @returns {Array<{length: number, operation: string}>}
     */
    parseCigar(cigar) {
        if (!cigar) return [];
        const operations = [];
        const regex = /(\d+)([MIDNSHPX=])/g;
        let match;
        while ((match = regex.exec(cigar)) !== null) {
            operations.push({ length: parseInt(match[1]), operation: match[2] });
        }
        return operations;
    }

    /**
     * Convert sequence and CIGAR string to aligned sequence and reference positions.
     * @param {string} sequence - The sequence.
     * @param {string} cigar - The CIGAR string.
     * @param {number} [componentStart] - Component start coordinate.
     * @returns {{aligned: string, positions: number[]}}
     */
    getAlignedSequence(sequence, cigar, componentStart) {
        if (!sequence || !cigar) return { aligned: sequence || '', positions: [] };
        const operations = this.parseCigar(cigar);
        let aligned = "", seqPos = 0, refPos = 0;
        const positions = [];
        for (const op of operations) {
            switch (op.operation) {
                case 'M': case '=': case 'X':
                    for (let i = 0; i < op.length; i++) {
                        if (seqPos < sequence.length) {
                            aligned += sequence[seqPos];
                            positions.push(refPos);
                            seqPos++;
                        }
                        refPos++;
                    }
                    break;
                case 'I':
                    for (let i = 0; i < op.length; i++) {
                        if (seqPos < sequence.length) {
                            aligned += sequence[seqPos].toLowerCase();
                            positions.push(refPos - 0.5);
                            seqPos++;
                        }
                    }
                    break;
                case 'D':
                    for (let i = 0; i < op.length; i++) {
                        aligned += '-';
                        positions.push(refPos);
                        refPos++;
                    }
                    break;
                case 'N':
                    refPos += op.length;
                    break;
                case 'S': case 'H':
                    seqPos += op.length;
                    break;
            }
        }
        return { aligned, positions };
    }

    /**
     * Draws the sequence letters and graphical glyphs (deletions, insertions) in a component rectangle.
     * @param {CanvasRenderingContext2D} ctx - 2D canvas context.
     * @param {Object} component - Chain component.
     * @param {number} x1 - Left pixel.
     * @param {number} x2 - Right pixel.
     * @param {number} yBox - Y coordinate of the box.
     * @param {number} hBox - Height of the box.
     * @param {number} bpPerPixel - Bases per pixel.
     * @param {number} bpStart - Reference start base.
     * @param {Object} sequenceInterval - Sequence interval (optional).
     * @param {string} strand - Strand ("+" or "-").
     * @param {number} bpEnd - Reference end base.
     */
    drawSequence(ctx, component, x1, x2, yBox, hBox, bpPerPixel, bpStart, sequenceInterval, strand, bpEnd) {
        if (!component.seq || !component.cigar) return;
        const { aligned, positions } = this.getAlignedSequence(component.seq, component.cigar);
        if (!aligned) return;

        ctx.save();
        ctx.font = this.sequenceFont;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const bp2px = bp => (bp - bpStart) / bpPerPixel;
        const centerY = yBox + hBox / 2 + 1;

        // Collect deletion and insertion locations
        const deletions = [], insertions = [];
        let i = 0;
        while (i < aligned.length) {
            const letter = aligned[i];
            const relativePos = positions[i];
            if (letter === '-' && relativePos >= 0) {
                // Detect continuous deletions
                const deletionStart = component.start + relativePos;
                let deletionLength = 0, j = i;
                while (j < aligned.length && aligned[j] === '-') {
                    deletionLength++; j++;
                }
                const deletionEnd = deletionStart + deletionLength;
                const startPixel = bp2px(deletionStart);
                const endPixel = bp2px(deletionEnd);
                if (endPixel >= x1 - 5 && startPixel <= x2 + 5) {
                    deletions.push({
                        start: deletionStart,
                        end: deletionEnd,
                        startPixel, endPixel, length: deletionLength
                    });
                }
                i = j;
            } else if (letter === letter.toLowerCase() && letter !== letter.toUpperCase()) {
                // Insertion
                const genomicPos = component.start + Math.floor(relativePos);
                const pixelX = bp2px(genomicPos + 1);
                if (pixelX >= x1 - 5 && pixelX <= x2 + 5) {
                    insertions.push(pixelX);
                }
                i++;
            } else {
                i++;
            }
        }

        // Draw component rectangle (split by deletions)
        ctx.fillStyle = component.color || ctx.fillStyle;
        if (deletions.length > 0) {
            deletions.sort((a, b) => a.start - b.start);
            let currentX = x1;
            const componentEnd = bp2px(component.end);
            for (const deletion of deletions) {
                if (currentX < deletion.startPixel) {
                    ctx.fillRect(currentX, yBox, deletion.startPixel - currentX, hBox);
                }
                // Draw connection line for deletion
                ctx.strokeStyle = component.color || "blue";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(deletion.startPixel, centerY);
                ctx.lineTo(deletion.endPixel, centerY);
                ctx.stroke();
                currentX = deletion.endPixel;
            }
            if (currentX < componentEnd) {
                ctx.fillRect(currentX, yBox, componentEnd - currentX, hBox);
            }
        } else {
            ctx.fillRect(x1, yBox, x2 - x1, hBox);
        }

        // Fetch component reference sequence if available
        let componentRefSeq = undefined;
        if (sequenceInterval && sequenceInterval.hasSequence(component.start, component.end)) {
            componentRefSeq = sequenceInterval.getSequence(component.start, component.end);
        }

        // Draw sequence letters (matches/mismatches only)
        ctx.font = this.sequenceFont;
        for (let i = 0; i < aligned.length; i++) {
            const letter = aligned[i];
            const relativePos = positions[i];
            if (letter !== '-' && relativePos >= 0 &&
                !(letter === letter.toLowerCase() && letter !== letter.toUpperCase())) {
                const genomicPos = component.start + relativePos;
                const pixelX = bp2px(genomicPos + 0.5);
                let base = ' ';
                if (componentRefSeq !== undefined && componentRefSeq[positions[i]] !== letter.toUpperCase()) {
                    base = letter.toUpperCase();
                }
                if (pixelX >= x1 - 5 && pixelX <= x2 + 5) {
                    ctx.fillStyle = "white";
                    ctx.fillText(base, pixelX, centerY);
                }
            }
        }

        // Draw insertion glyphs (vertical "I" symbol)
        ctx.font = this.insertionFont;
        ctx.fillStyle = "white";
        ctx.strokeStyle = "white";
        ctx.lineWidth = 2;
        for (const insX of insertions) {
            const glyphHeight = hBox * 0.6;
            const glyphWidth = 3;
            const glyphY = centerY - 1;
            // Vertical line
            ctx.beginPath();
            ctx.moveTo(insX, glyphY - glyphHeight/2);
            ctx.lineTo(insX, glyphY + glyphHeight/2);
            ctx.stroke();
            // Top horizontal line
            ctx.beginPath();
            ctx.moveTo(insX - glyphWidth/2, glyphY - glyphHeight/2);
            ctx.lineTo(insX + glyphWidth/2, glyphY - glyphHeight/2);
            ctx.stroke();
            // Bottom horizontal line
            ctx.beginPath();
            ctx.moveTo(insX - glyphWidth/2, glyphY + glyphHeight/2);
            ctx.lineTo(insX + glyphWidth/2, glyphY + glyphHeight/2);
            ctx.stroke();
        }

        ctx.restore();
    }

    /**
     * Render a chain feature (with all components, labels, arrows, and sequence if zoomed in).
     * @param {Object} feature - The chain feature.
     * @param {number} bpStart - Start base coordinate.
     * @param {number} bpPerPixel - Bases per pixel.
     * @param {number} pixelHeight - Pixel height of the track.
     * @param {CanvasRenderingContext2D} ctx - 2D canvas context.
     * @param {Object} options - Drawing options.
     */
    chainRender(feature, bpStart, bpPerPixel, pixelHeight, ctx, options) {
        ctx.save();
        try {
            const pixelTop = options.pixelTop;
            const extensionLen = 30;
            const yOffsetLabel = 2;
            const nameYOffset = 4;
            const hBox = this.boxHeight;
            const yBox = pixelTop + yOffsetLabel + this.smallLabelFontHeight + yOffsetLabel;

            ctx.font = this.labelFont;
            ctx.fillStyle = feature.color || "blue";
            ctx.strokeStyle = feature.color || "blue";

            const bp2px = bp => (bp - bpStart) / bpPerPixel;
            const shouldShowSequences = this.showSequences && bpPerPixel <= this.minZoomForSequences;

            // Draw each component (rectangle, chevrons, sequence, coordinate labels)
            feature.components.forEach((c, idx, arr) => {
                const x1 = bp2px(c.start);
                const x2 = bp2px(c.end);
                const width = x2 - x1;

                if (shouldShowSequences && c.seq && c.cigar) {
                    this.drawSequence(ctx, c, x1, x2, yBox, hBox, bpPerPixel, bpStart, options.sequenceInterval, feature.strand, options.bpEnd);
                } else {
                    ctx.fillRect(x1, yBox, width, hBox);

                    // Draw directional chevrons if box is wide enough
                    if (width > 8) {
                        const direction = feature.strand === '+' ? 1 : feature.strand === '-' ? -1 : 0;
                        if (direction !== 0) {
                            const cy = yBox + hBox / 2;
                            const step = this.chevronSpacing;
                            const oldFill = ctx.fillStyle, oldStroke = ctx.strokeStyle;
                            ctx.fillStyle = "white";
                            ctx.strokeStyle = "white";
                            ctx.lineWidth = 1;
                            for (let x = x1 + step / 2; x < x2; x += step) {
                                ctx.beginPath();
                                ctx.moveTo(x - direction * 2, cy - 2);
                                ctx.lineTo(x, cy);
                                ctx.stroke();
                                ctx.beginPath();
                                ctx.moveTo(x - direction * 2, cy + 2);
                                ctx.lineTo(x, cy);
                                ctx.stroke();
                            }
                            ctx.fillStyle = oldFill;
                            ctx.strokeStyle = oldStroke;
                        }
                    }
                }

                // Draw component coordinate labels (8pt)
                ctx.font = this.smallLabelFont;
                const labelY = yBox - yOffsetLabel;
                const ostartLabel = `${c.ostart + 1}`;
                const ostartWidth = ctx.measureText(ostartLabel).width;
                const ostartX = x1;
                const oldFillStyle = ctx.fillStyle;
                ctx.fillStyle = "black";

                let oendLabel = `${c.oend}`;
                if ( (options.chrLength - feature.end) * bpPerPixel < extensionLen ) {
                  oendLabel = `${c.oend} [${feature.osize - c.oend}]`;
                }

                const oendWidth = ctx.measureText(oendLabel).width;
                const oendX = x2 - oendWidth;

                if (oendX - (ostartX + ostartWidth) > 4) {
                    ctx.textAlign = "left";
                    ctx.fillText(ostartLabel, ostartX, labelY);
                    ctx.fillText(oendLabel, oendX, labelY);
                }
                ctx.fillStyle = oldFillStyle;
            });

            // Draw feature name label (centered or edge-aligned if not fully visible)
            if (feature.name) {
                ctx.save();
                ctx.font = this.labelFont;
                ctx.fillStyle = "black";
                const nameWidth = ctx.measureText(feature.name).width;
                const margin = 4, minLabelWidth = nameWidth + margin * 2;
                const featureX1 = Math.max(bp2px(feature.start), 0);
                const featureX2 = Math.min(bp2px(feature.end), ctx.canvas.width);
                const featureVisibleWidth = featureX2 - featureX1;
                if (featureVisibleWidth >= minLabelWidth) {
                    const viewportCenter = ctx.canvas.width / 2;
                    let labelX = viewportCenter, align = "center";
                    if (featureX1 > viewportCenter) {
                        labelX = featureX1 + margin; align = "left";
                    } else if (featureX2 < viewportCenter) {
                        labelX = featureX2 - margin; align = "right";
                    }
                    ctx.textAlign = align;
                    ctx.textBaseline = "top";
                    const labelY = yBox + hBox + nameYOffset;
                    ctx.fillText(feature.name, labelX, labelY);
                }
                ctx.restore();
            }

            // Draw lines between components; dashed if not contiguous in original coordinates
            const oldStroke = ctx.strokeStyle;
            ctx.strokeStyle = "black";
            ctx.lineWidth = 1;
            feature.components.slice(1).forEach((c, i) => {
                const prev = feature.components[i];
                const contiguous = (c.ostart - prev.oend) === 1;
                ctx.setLineDash(contiguous ? [] : [4, 4]);
                ctx.beginPath();
                ctx.moveTo(bp2px(prev.end), yBox + hBox / 2);
                ctx.lineTo(bp2px(c.start), yBox + hBox / 2);
                ctx.stroke();
                ctx.setLineDash([]);
            });
            ctx.strokeStyle = oldStroke;

            // Draw extension arms (arrows/labels) at the feature ends if applicable
            if ((feature.end - feature.start) / bpPerPixel > 3 * extensionLen) {
                const yTip = yBox;
                // No point in drawing extension out of the start of the possible viewport
                if ( feature.start * bpPerPixel > extensionLen ) { 
                  this.drawExtensionArm(ctx, {
                    x: bp2px(feature.components[0].start),
                    y: yTip,
                    yBox,
                    alignedEdge: feature.ostart + 1,
                    chromEdge: 1,
                    direction: -1,
                    bpPerPixel,
                    extensionLen,
                    chrLength: options.chrLength
                  }); 
                }
                // No point in drawing extension out of the end of the possible viewport
                if ( (options.chrLength - feature.end) * bpPerPixel > extensionLen ) {
                  this.drawExtensionArm(ctx, {
                    x: bp2px(feature.components[feature.components.length - 1].end),
                    y: yTip,
                    yBox,
                    alignedEdge: feature.oend,
                    chromEdge: feature.osize,
                    direction: 1,
                    bpPerPixel,
                    extensionLen,
                    chrLength: options.chrLength
                  });
                }
            }
        } finally {
            ctx.restore();
        }
    }

    /**
     * Draws an extension "arm" (dashed line, gap label, arrowhead) at a feature end.
     * @param {CanvasRenderingContext2D} ctx - 2D canvas context.
     * @param {Object} params - Drawing parameters.
     */
    drawExtensionArm(ctx, { x, y, yBox, alignedEdge, chromEdge, direction, bpPerPixel, extensionLen }) {
        const oldFill = ctx.fillStyle, oldStroke = ctx.strokeStyle;
        const arrowSize = 4, yOffsetExtLabel = 4;
        ctx.fillStyle = "grey";
        ctx.strokeStyle = "grey";
        ctx.lineWidth = 1;

        if (alignedEdge === chromEdge) {
            // Complete alignment - simple uptick
            ctx.beginPath();
            ctx.moveTo(x, yBox);
            ctx.lineTo(x, y);
            ctx.stroke();
        } else {
            // Incomplete alignment: draw dashed line, gap label, and arrow
            const gap = Math.abs(alignedEdge - chromEdge);
            const label = `${gap} bp`;
            ctx.font = this.labelFont;
            const labelWidth = ctx.measureText(label).width;

            // Before label: dashed line
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + direction * extensionLen, y);
            ctx.stroke();

            // After label: dashed line
            const afterLabelX = x + direction * (extensionLen + labelWidth);
            ctx.beginPath();
            ctx.moveTo(afterLabelX, y);
            ctx.lineTo(afterLabelX + direction * extensionLen, y);
            ctx.stroke();
            ctx.setLineDash([]);

            // Gap label between dashed segments
            const labelX = direction > 0
                ? x + direction * extensionLen
                : x + direction * (extensionLen + labelWidth);
            ctx.textAlign = "left";
            ctx.fillText(label, labelX, y + yOffsetExtLabel);

            // Arrowhead at end
            const arrowBase = afterLabelX + direction * extensionLen;
            ctx.beginPath();
            ctx.moveTo(arrowBase, y);
            ctx.lineTo(arrowBase - direction * arrowSize, y - arrowSize);
            ctx.moveTo(arrowBase, y);
            ctx.lineTo(arrowBase - direction * arrowSize, y + arrowSize);
            ctx.stroke();
        }
        ctx.fillStyle = oldFill;
        ctx.strokeStyle = oldStroke;
    }

    /**
     * Draws all features in this track.
     * @param {Object} options - Drawing options and context.
     */
    draw(options) {
        const {
            context, pixelWidth, pixelHeight, bpPerPixel, bpStart, bpEnd,
            pixelTop, features, referenceFrame
        } = options;

        const chromosome = referenceFrame.genome.getChromosome(referenceFrame.chr)
        const chrLength = chromosome ? chromosome.bpLength : 0;

        // If zoomed in enough and sequence display is enabled, fetch sequence interval
        if (this.showSequences && bpPerPixel < this.minZoomForSequences && this.browser && this.browser.genome) {
            options.sequenceInterval = this.browser.genome.getSequenceInterval(
                referenceFrame.chr,
                bpStart >= 0 ? bpStart : 0,
                bpEnd > chrLength ? chrLength : bpEnd
            );
        }

        const ctx = context;
        this.packFeatures(features, bpPerPixel, ctx);

        for (const f of features) {
            if (f.row !== undefined) {
                // expandedRowHeight controls vertical spacing
                const y = f.row * (this.expandedRowHeight || 24);
                this.chainRender(f, bpStart, bpPerPixel, pixelHeight, ctx, {
                    pixelTop: y,
                    bpPerPixel,
                    sequenceInterval: options.sequenceInterval,
                    bpEnd, chrLength
                });
            }
        }
    }
}

export default ChainTrack;
