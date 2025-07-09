import IGVGraphics from "../../igv-canvas.js"
import {getEonStart, getExonEnd, getExonPhase} from "../exonUtils.js"
import {translationDict} from "../../sequenceTrack.js"
import {complementSequence} from "../../util/sequenceUtils.js"

const aminoAcidSequenceRenderThreshold = 0.25

/**
 * @param feature
 * @param bpStart  genomic location of the left edge of the current canvas
 * @param xScale  scale in base-pairs per pixel
 * @returns {{px: number, px1: number, pw: number, h: number, py: number}}
 */
function calculateFeatureCoordinates(feature, bpStart, xScale) {
    let px = (feature.start - bpStart) / xScale
    let px1 = (feature.end - bpStart) / xScale
    //px = Math.round((feature.start - bpStart) / xScale),
    //px1 = Math.round((feature.end - bpStart) / xScale),
    let pw = px1 - px

    if (pw < 3) {
        pw = 3
        px -= 1.5
    }

    return {
        px: px,
        px1: px1,
        pw: pw
    }
}

/**
 *
 * @param feature
 * @param bpStart  genomic location of the left edge of the current canvas
 * @param xScale  scale in base-pairs per pixel
 * @param pixelHeight  pixel height of the current canvas
 * @param ctx  the canvas 2d context
 * @param options  genomic state
 */
function renderFeature(feature, bpStart, xScale, pixelHeight, ctx, options) {

    try {
        ctx.save()

        // Set ctx color to a known valid color.  If getColorForFeature returns an invalid color string it is ignored, and
        // this default will be used.
        ctx.fillStyle = this.color
        ctx.strokeStyle = this.color

        const color = this.getColorForFeature(feature)
        // const color = '+' === feature.strand ? 'rgba(135,206,235,0.5)' : 'rgba(255,20,147,0.5)'

        ctx.fillStyle = color
        ctx.strokeStyle = color

        let h
        let py
        if (this.displayMode === "SQUISHED" && feature.row !== undefined) {
            h = this.featureHeight / 2
            py = this.margin + this.squishedRowHeight * feature.row
        } else if (this.displayMode === "EXPANDED" && feature.row !== undefined) {
            h = this.featureHeight
            py = this.margin + this.expandedRowHeight * feature.row
        } else {  // collapsed
            h = this.featureHeight
            py = this.margin
        }

        const pixelWidth = options.pixelWidth   // typical 3*viewportWidth

        const cy = py + h / 2
        const h2 = h / 2
        const py2 = cy - h2 / 2

        const exonCount = feature.exons ? feature.exons.length : 0
        const coord = calculateFeatureCoordinates(feature, bpStart, xScale)
        const step = this.arrowSpacing
        const direction = feature.strand === '+' ? 1 : feature.strand === '-' ? -1 : 0

        if (exonCount === 0) {
            // single-exon transcript
            const xLeft = Math.max(0, coord.px)
            const xRight = Math.min(pixelWidth, coord.px1)
            const width = xRight - xLeft

            ctx.fillRect(xLeft, py, width, h)

            if (direction !== 0) {
                ctx.fillStyle = "white"
                ctx.strokeStyle = "white"
                for (let x = xLeft + step / 2; x < xRight; x += step) {
                    // draw arrowheads along central line indicating transcribed orientation
                    IGVGraphics.strokeLine(ctx, x - direction * 2, cy - 2, x, cy)
                    IGVGraphics.strokeLine(ctx, x - direction * 2, cy + 2, x, cy)
                }
                ctx.fillStyle = color
                ctx.strokeStyle = color
            }
        } else {

            // multi-exon transcript
            IGVGraphics.strokeLine(ctx, coord.px + 1, cy, coord.px1 - 1, cy) // center line for introns
            const xLeft = Math.max(0, coord.px) + step / 2
            const xRight = Math.min(pixelWidth, coord.px1)
            for (let x = xLeft; x < xRight; x += step) {
                // draw arrowheads along central line indicating transcribed orientation
                IGVGraphics.strokeLine(ctx, x - direction * 2, cy - 2, x, cy)
                IGVGraphics.strokeLine(ctx, x - direction * 2, cy + 2, x, cy)
            }

            for (let i = 0; i < feature.exons.length; i++) {

                const exon = feature.exons[i]

                // draw the exons
                let ePx = Math.round((exon.start - bpStart) / xScale)
                let ePx1 = Math.round((exon.end - bpStart) / xScale)
                let ePw = Math.max(1, ePx1 - ePx)
                let ePxU

                if (ePx + ePw < 0) {
                    continue  // Off the left edge
                }
                if (ePx > pixelWidth) {
                    break // Off the right edge
                }

                if (exon.utr) {
                    ctx.fillRect(ePx, py2, ePw, h2) // Entire exon is UTR
                } else {
                    if (exon.cdStart) {
                        ePxU = Math.round((exon.cdStart - bpStart) / xScale)
                        ctx.fillRect(ePx, py2, ePxU - ePx, h2) // start is UTR
                        ePw -= (ePxU - ePx)
                        ePx = ePxU
                    }
                    if (exon.cdEnd) {
                        ePxU = Math.round((exon.cdEnd - bpStart) / xScale)
                        ctx.fillRect(ePxU, py2, ePx1 - ePxU, h2) // start is UTR
                        ePw -= (ePx1 - ePxU)
                        ePx1 = ePxU
                    }

                    ePw = Math.max(ePw, 1)

                    ctx.fillRect(ePx, py, ePw, h)

                    if (exon.readingFrame !== undefined) {

                        if (options.bpPerPixel < aminoAcidSequenceRenderThreshold &&
                            options.sequenceInterval) {

                            const leftExon = i > 0 && feature.exons[i - 1].readingFrame !== undefined ? feature.exons[i - 1] : undefined
                            const riteExon = i < feature.exons.length - 1 && feature.exons[i + 1].readingFrame !== undefined ? feature.exons[i + 1] : undefined

                            renderAminoAcidSequence.call(this, ctx, feature.strand, leftExon, exon, riteExon, bpStart, options.bpPerPixel, py, h, options.sequenceInterval)
                        }
                    // Dfam - Handle bigPsl files containing translated alignments
                    // RMH: Is this a sufficient test for aligned protein features?
                    }else if ( feature.oSequence !== undefined ) {
                        if (options.bpPerPixel < aminoAcidSequenceRenderThreshold &&
                            options.sequenceInterval) {
                            renderAminoAcidSequenceAligned.call(this, ctx, feature, feature.strand, bpStart, options.bpPerPixel, py, h, options.sequenceInterval)
                        }
                    }

                    // Arrows
                    if (ePw > step + 5 && direction !== 0 && options.bpPerPixel > aminoAcidSequenceRenderThreshold) {
                        ctx.fillStyle = "white"
                        ctx.strokeStyle = "white"
                        for (let x = ePx + step / 2; x < ePx1; x += step) {
                            // draw arrowheads along central line indicating transcribed orientation
                            IGVGraphics.strokeLine(ctx, x - direction * 2, cy - 2, x, cy)
                            IGVGraphics.strokeLine(ctx, x - direction * 2, cy + 2, x, cy)
                        }
                        ctx.fillStyle = color
                        ctx.strokeStyle = color

                    }
                }
            }
        }

        if (options.drawLabel && this.displayMode !== "SQUISHED") {
            renderFeatureLabel.call(this, ctx, feature, coord.px, coord.px1, py, options.referenceFrame, options)
        }
    } finally {
        ctx.restore()
    }
}

// Dfam -- render *aligned* amino acid sequences rather than predicted ORFs
// RMH: This borrows much from the original renderAminoAcidSequence() function
//      and should probably be refactored alongside it.
function renderAminoAcidSequenceAligned(
    ctx, feature, strand, bpStart, bpPerPixel, y, height, sequenceInterval
) {
    const aaColors = ['rgb(124,124,204)', 'rgb(12, 12, 120)'];
    const oChromStarts = feature.oChromStarts.split(',').map(s => parseInt(s, 10));
    const oSequence = feature.oSequence;
    const proteinLength = oSequence.length;

    ctx.save();

    const renderAminoAcidLetter = (width, xs, y, aminoAcidLetter) => {
        if (aminoAcidLetter === 'STOP') aminoAcidLetter = '*';
        const aminoAcidLetterWidth = ctx.measureText(aminoAcidLetter).width;
        IGVGraphics.fillText(ctx, aminoAcidLetter, xs + (width - aminoAcidLetterWidth) / 2, y - 4, { fillStyle: '#ffffff' });
    };
                                                                                                                    
    const doPaint = (start, end, aminoAcidLetter, colorToggle, isMismatch, isRemainder) => {
        const xs = Math.round((start - bpStart) / bpPerPixel);
        const xe = Math.round((end - bpStart) / bpPerPixel);
        const width = xe - xs;

        ctx.fillStyle =(aminoAcidLetter === 'M' && proteinOffset === 0) ? '#83f902'
            : (aminoAcidLetter === 'STOP') ? '#ff2101'
            : isMismatch ? '#ffcc00'
            : aaColors[colorToggle];

        ctx.fillRect(xs, y, width, height);


        if (aminoAcidLetter) {
            ctx.save();
            if (isMismatch) {
                ctx.strokeStyle = '#ff0000';
                ctx.strokeRect(xs, y, width, height);
            }
            renderAminoAcidLetter(width, xs, y + height, aminoAcidLetter);
            ctx.restore();
        }
    };

    let codonBaseRemainder = 0;
    let proteinOffset = 0;

    const exonIndices = (strand === '+')
        ? [...Array(feature.exons.length).keys()]
        : [...Array(feature.exons.length).keys()].reverse();

    // This counter is across exons.  That means an exon might start
    // with a light color if the last exon ended on a dark color. This
    // is more likely to cause overlapping annotations to have shifted
    // light dark bands relative to each other.  Not sure there is better
    // way to assign this.
    let aminoAcidBackdropColorCounter = 1;

    for (const i of exonIndices) {
        const exon = feature.exons[i];
        const exonStart = exon.start;
        const exonEnd = exon.end;

        let bpPos = (strand === '+') ? exonStart : exonEnd;
        const exonLimit = (strand === '+') ? exonEnd : exonStart;
        const step = (strand === '+') ? 1 : -1;


        while ((strand === '+' && bpPos < exonLimit) || (strand === '-' && bpPos > exonLimit)) {
            const neededBases = 3 - codonBaseRemainder;
            const availableBases = Math.abs(exonLimit - bpPos);
            const drawBases = Math.min(neededBases, availableBases);

            const bpEnd = bpPos + (drawBases * step);
            const colorToggle = aminoAcidBackdropColorCounter % 2;

            const aaLetter = oSequence[proteinOffset] || undefined;
            const isRemainder = codonBaseRemainder > 0;

            let isMismatch = false;
            if (sequenceInterval.hasSequence(
                    (strand === '+') ? bpPos : bpEnd, 
                    (strand === '+') ? bpEnd : bpPos
                )) {

                const codonSeq = sequenceInterval.getSequence(
                    (strand === '+') ? bpPos : bpEnd, 
                    (strand === '+') ? bpEnd : bpPos
                );

                if (codonSeq && codonSeq.length === 3) {
                    const codon = (strand === '+')
                        ? codonSeq
                        : complementSequence(codonSeq.split('').reverse().join(''));

                    const translated = translationDict[codon];
                    if (translated && aaLetter && translated !== aaLetter) {
                        isMismatch = true;
                    }
                }
            }

            doPaint(
                (strand === '+') ? bpPos : bpEnd,
                (strand === '+') ? bpEnd : bpPos,
                aaLetter, colorToggle, isMismatch, isRemainder
            );

            codonBaseRemainder += drawBases;
            bpPos = bpEnd;

            if (codonBaseRemainder === 3) {
                aminoAcidBackdropColorCounter++;
                proteinOffset += 1;
                codonBaseRemainder = 0;
            }
        }

        // Redundant display across exon boundary
        if (codonBaseRemainder > 0 &&
            ((strand === '+' && i + 1 < feature.exons.length) ||
             (strand === '-' && i - 1 >= 0))) {

            const nextExon = (strand === '+') ? feature.exons[i + 1] : feature.exons[i - 1];
            const redundantBases = 3 - codonBaseRemainder;
            const redundantStart = (strand === '+') ? nextExon.start : nextExon.end - redundantBases;
            const redundantEnd = redundantStart + (redundantBases * step);

            const aaLetter = oSequence[proteinOffset] || undefined;

            doPaint(
                (strand === '+') ? redundantStart : redundantEnd,
                (strand === '+') ? redundantEnd : redundantStart,
                aaLetter, 0, false, true
            );
        }
    }

    ctx.restore();
}

function renderAminoAcidSequence(ctx, strand, leftExon, exon, riteExon, bpStart, bpPerPixel, y, height, sequenceInterval) {

    const aaColors =
        [
            'rgb(124,124,204)',
            'rgb(12, 12, 120)'
        ]


    ctx.save()

    const renderAminoAcidLetter = (strand, width, xs, y, aminoAcidLetter) => {

        if ('STOP' === aminoAcidLetter) {
            aminoAcidLetter = '*'
        }

        const aminoAcidLetterWidth = ctx.measureText(aminoAcidLetter).width
        IGVGraphics.fillText(ctx, aminoAcidLetter, xs + (width - aminoAcidLetterWidth) / 2, y - 4, {fillStyle: '#ffffff'})
    }

    const doPaint = (strand, start, end, aminoAcidLetter, colorToggle, index) => {

        const xs = Math.round((start - bpStart) / bpPerPixel)
        const xe = Math.round((end - bpStart) / bpPerPixel)

        const width = xe - xs

        let aaLetter
        if (undefined === aminoAcidLetter) {

            if (sequenceInterval.hasSequence(start, end)) {

                const sequence = sequenceInterval.getSequence(start, end)
                if (sequence && 3 === sequence.length) {
                    const key = '+' === strand ? sequence : complementSequence(sequence.split('').reverse().join(''))
                    aaLetter = translationDict[key]
                }
            }

        } else {
            aaLetter = aminoAcidLetter
        }

        if ('M' === aminoAcidLetter) {
            ctx.fillStyle = '#83f902'
        } else if ('M' === aaLetter && 0 === index) {
            ctx.fillStyle = '#83f902'
        } else if ('STOP' === aaLetter) {
            ctx.fillStyle = '#ff2101'
        } else {
            ctx.fillStyle = aaColors[colorToggle]
        }

        ctx.fillRect(xs, y, width, height)

        if (aaLetter) {
            ctx.save()
            renderAminoAcidLetter(strand, width, xs, y + height, aaLetter)
            ctx.restore()
        }

        const widthBP = end - start
        return widthBP > 0 && widthBP < 3 ? {start, end} : undefined
    }

    const phase = getExonPhase(exon)
    let ss = getEonStart(exon)
    let ee = getExonEnd(exon)

    let bpTripletStart
    let bpTripletEnd

    let remainder
    let aminoAcidBackdropColorCounter = 1
    let colorToggle
    let index
    if ('+' === strand) {

        if (phase > 0) {
            ss += phase
        }

        aminoAcidBackdropColorCounter = 1
        for (index = 0, bpTripletStart = ss; bpTripletStart < ee; index++, bpTripletStart += 3) {
            colorToggle = aminoAcidBackdropColorCounter % 2
            bpTripletEnd = Math.min(ee, bpTripletStart + 3)
            remainder = doPaint(strand, bpTripletStart, bpTripletEnd, undefined, aminoAcidBackdropColorCounter % 2, index)
            ++aminoAcidBackdropColorCounter
        }

        if (phase > 0 || remainder) {

            const result = phase > 0
                ? getAminoAcidLetterWithExonGap.call(this, strand, phase, ss - phase, ss, remainder, leftExon, exon, riteExon, sequenceInterval)
                : getAminoAcidLetterWithExonGap.call(this, strand, undefined, undefined, undefined, remainder, leftExon, exon, riteExon, sequenceInterval)

            if (result) {
                const {left, rite} = result

                if (left) {
                    doPaint(strand, ss - phase, ss, left.aminoAcidLetter, 0, undefined)
                }

                if (rite) {
                    doPaint(strand, remainder.start, remainder.end, rite.aminoAcidLetter, colorToggle, undefined)
                }

            }

        }

    } else {

        if (phase > 0) {
            ee -= phase
        }

        aminoAcidBackdropColorCounter = 1
        index = 0
        for (index = 0, bpTripletEnd = ee; bpTripletEnd > ss; index++, bpTripletEnd -= 3) {
            colorToggle = aminoAcidBackdropColorCounter % 2
            bpTripletStart = Math.max(ss, bpTripletEnd - 3)
            remainder = doPaint(strand, bpTripletStart, bpTripletEnd, undefined, aminoAcidBackdropColorCounter % 2, index)
            ++aminoAcidBackdropColorCounter
        }

        if (phase > 0 || remainder) {

            const result = phase > 0
                ? getAminoAcidLetterWithExonGap.call(this, strand, phase, ee, ee + phase, remainder, leftExon, exon, riteExon, sequenceInterval)
                : getAminoAcidLetterWithExonGap.call(this, strand, undefined, undefined, undefined, remainder, leftExon, exon, riteExon, sequenceInterval)

            if (result) {
                const {left, rite} = result

                if (rite) {
                    doPaint(strand, ee, ee + phase, rite.aminoAcidLetter, 0, undefined)
                }

                if (left) {
                    doPaint(strand, remainder.start, remainder.end, left.aminoAcidLetter, colorToggle, undefined)
                }

            }

        }

    }

    ctx.restore()
}

/**
 * @param ctx       the canvas 2d context
 * @param feature
 * @param featureX  feature start in pixel coordinates
 * @param featureX1 feature end in pixel coordinates
 * @param featureY  feature y-coordinate
 * @param referenceFrame  genomic state
 * @param options  options
 */
function renderFeatureLabel(ctx, feature, featureX, featureX1, featureY, referenceFrame, options) {

    try {
        ctx.save()

        const labelField = this.config.labelField ? this.config.labelField : 'name'
        let name = feature[labelField]
        if (name === undefined && feature.gene) name = feature.gene.name
        if (name === undefined) name = feature.id || feature.ID
        if (!name || name === '.') return

        let pixelXOffset = options.pixelXOffset || 0
        const t1 = Math.max(featureX, -pixelXOffset)
        const t2 = Math.min(featureX1, -pixelXOffset + options.viewportWidth)
        let centerX = (t1 + t2) / 2
        //let centerX = (featureX + featureX1) / 2

        let transform
        if (this.displayMode === "COLLAPSED" && this.labelDisplayMode === "SLANT") {
            transform = {rotate: {angle: 45}}
        }
        const labelY = getFeatureLabelY(featureY, transform)

        let color = this.getColorForFeature(feature)
        let selected = this.browser.qtlSelections.hasPhenotype(feature.name)

        const geneFontStyle = {
            textAlign: "SLANT" === this.labelDisplayMode ? undefined : 'center',
            // Dfam - Use the labelColor if defined, otherwise use the color
            fillStyle: this.labelColor === undefined ? color : this.labelColor,
            strokeStyle: this.labelColor === undefined ? color : this.labelColor,
        }

        const textMetrics = ctx.measureText(name)
        const xleft = centerX - textMetrics.width / 2
        const xright = centerX + textMetrics.width / 2
        const lastLabelX = options.rowLastLabelX[feature.row] || -Number.MAX_SAFE_INTEGER
        if (options.labelAllFeatures || xleft > lastLabelX || selected) {
            options.rowLastLabelX[feature.row] = xright

            ctx.clearRect(
                centerX - textMetrics.width / 2 - 1,
                labelY - textMetrics.actualBoundingBoxAscent - 1,
                textMetrics.width + 2,
                textMetrics.actualBoundingBoxAscent + textMetrics.actualBoundingBoxDescent + 2)
            IGVGraphics.fillText(ctx, name, centerX, labelY, geneFontStyle, transform)

        }

    } finally {
        ctx.restore()
    }
}

function getFeatureLabelY(featureY, transform) {
    return transform ? featureY + 20 : featureY + 25
}

function getAminoAcidLetterWithExonGap(strand, phase, phaseExtentStart, phaseExtentEnd, remainder, leftExon, exon, riteExon, sequenceInterval) {

    let ss
    let ee
    let stringA = ''
    let stringB = ''
    let triplet = ''

    const aminoAcidLetters = {left: undefined, rite: undefined}
    if ('+' === strand) {

        if (phase) {
            stringB = sequenceInterval.getSequence(phaseExtentStart, phaseExtentEnd)

            if (!stringB) {
                return undefined
            }

            [ss, ee] = [getExonEnd(leftExon) - (3 - phase), getExonEnd(leftExon)]
            stringA = sequenceInterval.getSequence(ss, ee)

            if (!stringA) {
                return undefined
            }

            triplet = stringA + stringB
            aminoAcidLetters.left = {triplet, aminoAcidLetter: translationDict[triplet]}
        }

        if (remainder) {
            stringA = sequenceInterval.getSequence(remainder.start, remainder.end)

            if (!stringA) {
                return undefined
            }

            const ritePhase = getExonPhase(riteExon)
            const riteStart = getEonStart(riteExon)
            stringB = sequenceInterval.getSequence(riteStart, riteStart + ritePhase)

            if (!stringB) {
                return undefined
            }

            triplet = stringA + stringB
            aminoAcidLetters.rite = {triplet, aminoAcidLetter: translationDict[triplet]}
        }

    } else {

        if (phase) {
            stringA = sequenceInterval.getSequence(phaseExtentStart, phaseExtentEnd)

            if (undefined === stringA) {
                return undefined
            }

            [ss, ee] = [getEonStart(riteExon), getEonStart(riteExon) + (3 - phase)]
            stringB = sequenceInterval.getSequence(ss, ee)

            if (undefined === stringB) {
                return undefined
            }

            triplet = stringA + stringB
            triplet = complementSequence(triplet.split('').reverse().join(''))
            aminoAcidLetters.rite = {triplet, aminoAcidLetter: translationDict[triplet]}
        }

        if (remainder) {
            stringB = sequenceInterval.getSequence(remainder.start, remainder.end)

            if (undefined === stringB) {
                return undefined
            }

            const leftPhase = getExonPhase(leftExon)
            const leftEnd = getExonEnd(leftExon)
            stringA = sequenceInterval.getSequence(leftEnd - leftPhase, leftEnd)

            if (undefined === stringA) {
                return undefined
            }

            triplet = stringA + stringB
            triplet = complementSequence(triplet.split('').reverse().join(''))
            aminoAcidLetters.left = {triplet, aminoAcidLetter: translationDict[triplet]}
        }
    }

    return aminoAcidLetters
}


// exon

export {aminoAcidSequenceRenderThreshold, calculateFeatureCoordinates, renderFeature}


