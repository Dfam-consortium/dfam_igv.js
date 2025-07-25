import BaseModificationRenderer from "./mods/baseModificationRenderer.js"
import IGVGraphics from "../igv-canvas.js"
import PairedAlignment from "./pairedAlignment.js"
import {IGVColor, StringUtils} from "../../node_modules/igv-utils/src/index.js"
import {isSecureContext} from "../util/igvUtils.js"
import {createBlatTrack, maxSequenceSize} from "../blat/blatTrack.js"
import {reverseComplementSequence} from "../util/sequenceUtils.js"
import orientationTypes from "./orientationTypes.js"
import {ColorTable, PaletteColorTable} from "../util/colorPalletes.js"
import TrackBase from "../trackBase.js"
import {getChrColor} from "../util/getChrColor.js"
import {createCheckbox} from "../igv-icons.js"
import {modificationName} from "./mods/baseModificationUtils.js"
import {createElementWithString} from "../ui/utils/dom-utils.js"
import BAMTrack from "./bamTrack.js"


const alignmentStartGap = 5
const downsampleRowHeight = 10
const groupGap = 10
const DEFAULT_ALIGNMENT_COLOR = "rgb(185, 185, 185)"
const DEFAULT_CONNECTOR_COLOR = "rgb(200, 200, 200)"
const DEFAULT_HIGHLIGHT_COLOR = "#00ff00"
const MINIMUM_BLAT_LENGTH = 20

const pairCompatibleGroupOptions = new Set(["firstOfPairStrand"])

class AlignmentTrack extends TrackBase {

    static defaults = {
        viewAsPairs: false,
        showSoftClips: false,
        showAllBases: false,
        showInsertions: true,
        showMismatches: true,
        colorBy: undefined,
        groupBy: undefined,
        displayMode: "EXPANDED",
        alignmentRowHeight: 14,
        squishedRowHeight: 3,
        negStrandColor: "rgba(150, 150, 230, 0.75)",
        posStrandColor: "rgba(230, 150, 150, 0.75)",
        baseModPosStrandColor: "rgb(195, 195, 195)",
        baseModNegStrandColor: "rgb(195, 210, 195)",
        insertionColor: "rgb(138, 94, 161)",
        insertionTextColor: "white",
        showInsertionText: false,
        deletionColor: "black",
        deletionTextColor: "black",
        showDeletionText: false,
        skippedColor: "rgb(150, 170, 170)",
        pairConnectorColor: undefined,
        smallTLENColor: "rgb(0, 0, 150)",
        largeTLENColor: "rgb(200, 0, 0)",
        expectedPairOrientation: 'fr',
        rlColor: "rgb(0, 150, 0)",
        rrColor: "rgb(20, 50, 200)",
        llColor: "rgb(0, 150, 150)",
        bamColorTag: "YC",
        hideSmallIndels: false,
        indelSizeThreshold: 1,
        highlightColor: undefined,
        minTLEN: undefined,
        maxTLEN: undefined,
        tagColorPallete: "Set1",
    }

    _colorTables = new Map()
    _baseModifications = new Set()

    constructor(config, browser) {

        super(config, browser)

        // Explicit color table
        if (config.colorTable || config.tagColorTable) {
            this.colorTable = new ColorTable(config.tagColorTable)
        }

        // Only one of showTags / hideTags should be specified.  If both are specified showTags takes precedence.
        if (config.showTags && config.hideTags) {
            console.warn("Both showTags and hideTags specified.  showTags will be used.")
        }
        if (config.showTags) {
            this.showTags = new Set(config.showTags)
            this.hiddenTags = new Set()
        } else {
            this.hiddenTags = new Set(config.hideTags || ["SA", "MD"])
        }


        // Backward compatibility overrides
        if (config.largeFragmentLengthColor) this.largeTLENColor = config.largeFragmentLengthColor
        if (config.pairOrienation) this.expectedPairOrientation = config.pairOrientation
        if (config.smallFragmentLengthColor) this.smallTLENColor = config.smallFragmentLengthColor
        if (config.largeFragmentLengthColor) this.largeTLENColor = config.largeFragmentLengthColor
        if (config.minFragmentLength) this.minTLEN = config.minFragmentLength
        if (config.maxFragmentLength) this.maxTLEN = config.maxFragmentLength
        if (config.displayMode) this.displayMode = config.displayMode.toUpperCase()
        if (config.colorBy && config.colorByTag) {
            this.colorBy = config.colorBy + ":" + config.colorByTag
        }

        this.featureSource = this.parent.featureSource
        this.top = 0 === config.coverageTrackHeight ? 0 : config.coverageTrackHeight + 5

        this.pairColors = {
            "RL": this.rlColor,
            "RR": this.rrColor,
            "LL": this.llColor
        }

        if (config.highlightedReads) {
            this.setHighlightedReads(config.highlightedReads)
        }

        this.hasPairs = false   // Until proven otherwise
        this.hasSupplemental = false


        this._groupByTags = []
        this._groupByPositions = []
        if (config.groupBy) {
            this.groupBy = config.groupBy
            if (config.groupBy.startsWith("base:")) {
                this._groupByPositions.push(config.groupBy.substring(5))
            }
            if (config.groupBy.startsWith("tag:")) {
                this._groupByTags.push(config.groupBy.substring(4))
            }
        }

        // Listen for locus change events,  needed to repack alignments when in "FULL" mode
        this._locusChange = locusChange.bind(this)
        this.browser.on('locuschange', this._locusChange)
    }

    init(config) {
        this.parent = config.parent  // A hack to get around initialization problem
        delete config.parent
        super.init(config)
    }

    dispose() {
        this.browser.off('locuschage', this._locusChange)
    }

    /**
     * Lazy initialize a base modification renderer
     *
     * @returns {BaseModificationRenderer}
     */
    get baseModRenderer() {
        if (!this._baseModRenderer) {
            this._baseModRenderer = new BaseModificationRenderer(this)
        }
        return this._baseModRenderer
    }

    get baseModificationThreshold() {
        return this.parent.baseModificationThreshold
    }

    setTop(coverageTrack, showCoverage) {
        this.top = (0 === coverageTrack.height || false === showCoverage) ? 0 : (5 + coverageTrack.height)
    }

    setHighlightedReads(highlightedReads, highlightColor) {
        if (!Array.isArray(highlightedReads) || !highlightedReads.every(i => typeof i === "string")) {
            throw new Error("AlignmentTrack.setHighlightedReads() only accept array of strings")
        }
        if (highlightColor) {
            this.highlightColor = highlightColor
        }
        this.highlightedReads = new Set(highlightedReads)
    }

    /**
     * Compute the pixel height required to display all content.
     *
     * @param alignmentContainer
     * @returns {number|*}
     */
    computePixelHeight(alignmentContainer) {

        if (alignmentContainer.packedGroups) {
            let h = alignmentContainer.hasDownsampledIntervals() ? downsampleRowHeight + alignmentStartGap : 0
            const alignmentRowHeight = this.displayMode === "SQUISHED" ?
                this.squishedRowHeight :
                this.alignmentRowHeight
            for (let group of alignmentContainer.packedGroups.values()) {
                h += (alignmentRowHeight * group.length) + groupGap
            }
            return h + 5
        } else {
            return 0
        }
    }

    draw(options) {

        const alignmentContainer = options.features
        const ctx = options.context
        const bpPerPixel = options.bpPerPixel
        const bpStart = options.bpStart
        const pixelWidth = options.pixelWidth
        const bpEnd = bpStart + pixelWidth * bpPerPixel + 1
        const showSoftClips = this.showSoftClips
        const showAllBases = this.showAllBases
        const nucleotideColors = this.browser.nucleotideColors

        ctx.save()

        // Update base modification keys.
        for (let k of alignmentContainer.baseModificationKeys) {
            this._baseModifications.add(k.modification)
        }

        let referenceSequence = alignmentContainer.sequence
        if (referenceSequence) {
            referenceSequence = referenceSequence.toUpperCase()
        }
        let alignmentRowYInset = 0

        // Set colorBy default if neccessary
        if (!this.colorBy) {
            this.colorBy = this.hasPairs ? "unexpectedPair" : "none"
        }

        let pixelTop = options.pixelTop - BAMTrack.coverageTrackHeight
        if (this.top) {
            ctx.translate(0, this.top)
        }
        const pixelBottom = pixelTop + options.pixelHeight

        if (alignmentContainer.hasDownsampledIntervals()) {
            alignmentRowYInset = downsampleRowHeight + alignmentStartGap

            alignmentContainer.downsampledIntervals.forEach(function (interval) {
                var xBlockStart = (interval.start - bpStart) / bpPerPixel,
                    xBlockEnd = (interval.end - bpStart) / bpPerPixel

                if (xBlockEnd - xBlockStart > 5) {
                    xBlockStart += 1
                    xBlockEnd -= 1
                }
                IGVGraphics.fillRect(ctx, xBlockStart, 2, (xBlockEnd - xBlockStart), downsampleRowHeight - 2, {fillStyle: "black"})
            })

        } else {
            alignmentRowYInset = 0
        }

        // Transient variable -- rewritten on every draw, used for click object selection
        this.alignmentsYOffset = alignmentRowYInset
        const alignmentRowHeight = this.displayMode === "SQUISHED" ?
            this.squishedRowHeight :
            this.alignmentRowHeight

        const packedAlignmentGroups = alignmentContainer.packedGroups

        if (packedAlignmentGroups) {

            let alignmentY = alignmentRowYInset
            for (let groupName of packedAlignmentGroups.keys()) {

                const group = packedAlignmentGroups.get(groupName)
                const packedAlignmentRows = group.rows
                const nRows = packedAlignmentRows.length
                group.pixelTop = alignmentY

                for (let rowIndex = 0; rowIndex < nRows; rowIndex++) {

                    const alignmentRow = packedAlignmentRows[rowIndex]
                    const alignmentHeight = alignmentRowHeight <= 4 ? alignmentRowHeight : alignmentRowHeight - 2

                    if (alignmentY > pixelBottom) {
                        break
                    } else if (alignmentY + alignmentHeight < pixelTop) {
                        alignmentY += alignmentRowHeight
                        continue
                    }

                    for (let alignment of alignmentRow.alignments) {

                        if (this.browser.circularView) {
                            // This is an expensive check, only do it if needed
                            this.hasSupplemental = this.hasSupplemental || alignment.hasTag('SA')
                        }

                        if ((alignment.start + alignment.lengthOnRef) < bpStart) continue
                        if (alignment.start > bpEnd) break
                        if (true === alignment.hidden) {
                            continue
                        }

                        if (alignment instanceof PairedAlignment) {

                            drawPairConnector.call(this, alignment, alignmentY, alignmentHeight)

                            drawSingleAlignment.call(this, alignment.firstAlignment, alignmentY, alignmentHeight)

                            if (alignment.secondAlignment) {
                                drawSingleAlignment.call(this, alignment.secondAlignment, alignmentY, alignmentHeight)
                            }

                        } else {
                            drawSingleAlignment.call(this, alignment, alignmentY, alignmentHeight)
                        }
                    }
                    alignmentY += alignmentRowHeight
                }

                group.pixelBottom = alignmentY

                if (this.groupBy && groupName) {

                    ctx.save()

                    ctx.font = '400 12px sans-serif'
                    const textMetrics = ctx.measureText(groupName)
                    const w = textMetrics.width + 10
                    const x = -options.pixelShift + options.viewportWidth - w - 10
                    const h = textMetrics.actualBoundingBoxAscent + textMetrics.actualBoundingBoxDescent + 10
                    const baselineY = Math.min(group.pixelTop + h - 1, group.pixelBottom)

                    ctx.textAlign = "center"
                    ctx.fillStyle = 'white'
                    ctx.strokeStyle = 'lightGray'
                    IGVGraphics.roundRect(ctx, x, baselineY - textMetrics.actualBoundingBoxAscent - 5, w, h, 2, 1, 1)

                    ctx.fillStyle = 'black'
                    ctx.fillText(groupName, x + w / 2, baselineY)
                    IGVGraphics.dashedLine(ctx, 0, alignmentY, pixelWidth, alignmentY)

                    ctx.restore()

                    alignmentY += groupGap  // Group separator
                }
            }
        }
        ctx.restore()

        // alignment is a PairedAlignment
        function drawPairConnector(alignment, yRect, alignmentHeight) {

            var connectorColor = this.getConnectorColor(alignment.firstAlignment),
                xBlockStart = (alignment.connectingStart - bpStart) / bpPerPixel,
                xBlockEnd = (alignment.connectingEnd - bpStart) / bpPerPixel,
                yStrokedLine = yRect + alignmentHeight / 2

            if ((alignment.connectingEnd) < bpStart || alignment.connectingStart > bpEnd) {
                return
            }
            if (alignment.mq <= 0) {
                connectorColor = IGVColor.addAlpha(connectorColor, 0.15)
            }
            IGVGraphics.setProperties(ctx, {fillStyle: connectorColor, strokeStyle: connectorColor})
            IGVGraphics.strokeLine(ctx, xBlockStart, yStrokedLine, xBlockEnd, yStrokedLine)

        }

        function drawSingleAlignment(alignment, y, alignmentHeight) {


            if ((alignment.start + alignment.lengthOnRef) < bpStart || alignment.start > bpEnd) {
                return
            }

            const blocks = showSoftClips ? alignment.blocks : alignment.blocks.filter(b => 'S' !== b.type)

            let alignmentColor = this.getAlignmentColor(alignment)
            const outlineColor = alignmentColor
            if (alignment.mq <= 0) {
                alignmentColor = IGVColor.addAlpha(alignmentColor, 0.15)
            }
            IGVGraphics.setProperties(ctx, {fillStyle: alignmentColor, strokeStyle: outlineColor})

            // Save bases to draw into an array for later drawing, so they can be overlaid on insertion blocks,
            // which is relevant if we have insertions with size label
            const basesToDraw = []

            for (let b = 0; b < blocks.length; b++) {   // Can't use forEach here -- we need ability to break

                const block = blocks[b]

                // Somewhat complex test, neccessary to insure gaps are drawn.
                // If this is not the last block, and the next block starts before the orign (off screen to left) then skip.
                if ((b !== blocks.length - 1) && blocks[b + 1].start < bpStart) continue

                // drawBlock returns bases to draw, which are drawn on top of insertion blocks (if they're wider than
                // the space between two bases) like in Java IGV
                basesToDraw.push(...drawBlock.call(this, block, b))

                if ((block.start + block.len) > bpEnd) {
                    // Do this after drawBlock to insure gaps are drawn
                    break
                }
            }

            if (alignment.gaps) {
                const yStrokedLine = y + alignmentHeight / 2
                for (let gap of alignment.gaps) {
                    const sPixel = (gap.start - bpStart) / bpPerPixel
                    const ePixel = ((gap.start + gap.len) - bpStart) / bpPerPixel
                    const lineWidth = ePixel - sPixel
                    const gapLenText = gap.len.toString()
                    const gapTextWidth = gapLenText.length * 6
                    const gapCenter = sPixel + (lineWidth / 2)

                    const color = ("D" === gap.type) ? this.deletionColor : this.skippedColor

                    IGVGraphics.strokeLine(ctx, sPixel, yStrokedLine, ePixel, yStrokedLine, {
                        strokeStyle: color,
                        lineWidth: 2,
                    })

                    // Add gap width as text like Java IGV if it fits nicely and is a multi-base gap
                    if (this.showDeletionText && gap.len > 1 && lineWidth >= gapTextWidth + 8) {
                        const textStart = gapCenter - (gapTextWidth / 2)
                        IGVGraphics.fillRect(ctx, textStart - 1, y - 1, gapTextWidth + 2, 12, {fillStyle: "white"})
                        IGVGraphics.fillText(ctx, gapLenText, textStart, y + 10, {
                            'font': 'normal 10px monospace',
                            'fillStyle': this.deletionTextColor,
                        })
                    }
                }
            }

            if (alignment.insertions && this.showInsertions) {
                let lastXBlockStart = -1
                for (let insertionBlock of alignment.insertions) {
                    if (this.hideSmallIndels && insertionBlock.len <= this.indelSizeThreshold) {
                        continue
                    }
                    if (insertionBlock.start < bpStart) {
                        continue
                    }
                    if (insertionBlock.start > bpEnd) {
                        break
                    }

                    const refOffset = insertionBlock.start - bpStart
                    const insertLenText = insertionBlock.len.toString()

                    const textPixelWidth = 2 + (insertLenText.length * 6)
                    const basePixelWidth = (!this.showInsertionText || insertionBlock.len === 1)
                        ? 2
                        : Math.round(insertionBlock.len / bpPerPixel)
                    const widthBlock = Math.max(Math.min(textPixelWidth, basePixelWidth), 2)

                    const xBlockStart = (refOffset / bpPerPixel) - (widthBlock / 2)
                    if ((xBlockStart - lastXBlockStart) > 2) {
                        const props = {fillStyle: this.insertionColor}

                        // Draw decorations like Java IGV to make an 'I' shape
                        IGVGraphics.fillRect(ctx, xBlockStart - 2, y, widthBlock + 4, 2, props)
                        IGVGraphics.fillRect(ctx, xBlockStart, y + 2, widthBlock, alignmentHeight - 4, props)
                        IGVGraphics.fillRect(ctx, xBlockStart - 2, y + alignmentHeight - 2, widthBlock + 4, 2, props)

                        // Show # of inserted bases as text if it's a multi-base insertion and the insertion block
                        // is wide enough to hold text (its size is capped at the text label size, but can be smaller
                        // if the browser is zoomed out and the insertion is small)
                        if (this.showInsertionText && insertionBlock.len > 1 && basePixelWidth > textPixelWidth) {
                            IGVGraphics.fillText(ctx, insertLenText, xBlockStart + 1, y + 10, {
                                'font': 'normal 10px monospace',
                                'fillStyle': this.insertionTextColor,
                            })
                        }
                        lastXBlockStart = xBlockStart
                    }
                }
            }

            for (let {bbox, baseColor, readChar} of basesToDraw) {
                const threshold = 1.0 / 10.0
                if (bpPerPixel <= threshold && bbox.height >= 8) {
                    // render letter
                    const fontHeight = Math.min(10, bbox.height)
                    ctx.font = '' + fontHeight + 'px sans-serif'
                    const center = bbox.x + (bbox.width / 2.0)
                    IGVGraphics.strokeText(ctx, readChar, center - (ctx.measureText(readChar).width / 2), fontHeight - 1 + bbox.y, {strokeStyle: baseColor})
                } else {

                    // render colored block
                    IGVGraphics.fillRect(ctx, bbox.x, bbox.y, bbox.width, bbox.height, {fillStyle: baseColor})
                }
            }

            if (this.colorBy && this.colorBy.startsWith("basemod")) {
                const context = (
                    {
                        ctx,
                        bpPerPixel,
                        bpStart,
                        bpEnd,
                        pixelEnd: pixelWidth
                    })
                this.baseModRenderer.drawModifications(alignment, y, alignmentHeight, context, this.colorBy, this.baseModificationThreshold)
            }


            function drawBlock(block, b) {
                // Collect bases to draw for later rendering
                const blockBasesToDraw = []

                const offsetBP = block.start - alignmentContainer.start
                const blockStartPixel = (block.start - bpStart) / bpPerPixel
                const blockEndPixel = ((block.start + block.len) - bpStart) / bpPerPixel
                const blockWidthPixel = Math.max(1, blockEndPixel - blockStartPixel)

                //const arrowHeadWidthPixel = alignmentRowHeight / 2.0;
                const nomPixelWidthOnRef = 100 / bpPerPixel
                const arrowHeadWidthPixel = Math.min(alignmentRowHeight / 2.0, nomPixelWidthOnRef / 6)

                const isSoftClip = 'S' === block.type

                const strokeOutline =
                    alignment.mq <= 0 ||
                    this.selectedReadName === alignment.readName ||
                    isSoftClip ||
                    this.highlightedReads && this.highlightedReads.has(alignment.readName)

                let blockOutlineColor = outlineColor
                if (this.selectedReadName === alignment.readName) {
                    blockOutlineColor = 'red'
                } else if (isSoftClip) {
                    blockOutlineColor = 'rgb(50,50,50)'
                } else if (this.highlightedReads && this.highlightedReads.has(alignment.readName)) {
                    blockOutlineColor = this.highlightColor || DEFAULT_HIGHLIGHT_COLOR
                }

                const lastBlockPositiveStrand = (true === alignment.strand && b === blocks.length - 1)
                const lastBlockReverseStrand = (false === alignment.strand && b === 0)
                const lastBlock = lastBlockPositiveStrand | lastBlockReverseStrand

                if (lastBlock) {
                    let xListPixel
                    let yListPixel
                    if (lastBlockPositiveStrand) {
                        xListPixel = [
                            blockStartPixel,
                            blockEndPixel,
                            blockEndPixel + arrowHeadWidthPixel,
                            blockEndPixel,
                            blockStartPixel,
                            blockStartPixel]
                        yListPixel = [
                            y,
                            y,
                            y + (alignmentHeight / 2.0),
                            y + alignmentHeight,
                            y + alignmentHeight,
                            y]

                    }

                    // Last block on - strand ?
                    else if (lastBlockReverseStrand) {
                        xListPixel = [
                            blockEndPixel,
                            blockStartPixel,
                            blockStartPixel - arrowHeadWidthPixel,
                            blockStartPixel,
                            blockEndPixel,
                            blockEndPixel]
                        yListPixel = [
                            y,
                            y,
                            y + (alignmentHeight / 2.0),
                            y + alignmentHeight,
                            y + alignmentHeight,
                            y]

                    }
                    IGVGraphics.fillPolygon(ctx, xListPixel, yListPixel, {fillStyle: alignmentColor})

                    if (strokeOutline) {
                        IGVGraphics.strokePolygon(ctx, xListPixel, yListPixel, {strokeStyle: blockOutlineColor})
                    }
                }

                // Internal block
                else {
                    IGVGraphics.fillRect(ctx, blockStartPixel, y, blockWidthPixel, alignmentHeight, {fillStyle: alignmentColor})

                    if (strokeOutline) {
                        ctx.save()
                        ctx.strokeStyle = blockOutlineColor
                        ctx.strokeRect(blockStartPixel, y, blockWidthPixel, alignmentHeight)
                        ctx.restore()
                    }
                }


                // Read base coloring

                if (isSoftClip ||
                    showAllBases ||
                    this.showMismatches && (referenceSequence && alignment.seq && alignment.seq !== "*")) {

                    const seq = alignment.seq ? alignment.seq.toUpperCase() : undefined
                    const qual = alignment.qual
                    const seqOffset = block.seqOffset
                    const widthPixel = Math.max(1, 1 / bpPerPixel)


                    for (let i = 0, len = block.len; i < len; i++) {

                        const xPixel = ((block.start + i) - bpStart) / bpPerPixel

                        if (xPixel + widthPixel < 0) continue   // Off left edge
                        if (xPixel > pixelWidth) break  // Off right edge

                        let readChar = seq ? seq.charAt(seqOffset + i) : ''
                        const refChar = offsetBP + i >= 0 ? referenceSequence.charAt(offsetBP + i) : ''

                        if (readChar === "=") {
                            readChar = refChar
                        }
                        if (readChar === "X" || refChar !== readChar || isSoftClip || showAllBases) {

                            let baseColor = nucleotideColors[readChar] || "rgb(0,0,0)"
                            if (!isSoftClip && qual !== undefined && qual.length > seqOffset + i) {
                                const readQual = qual[seqOffset + i]
                                baseColor = shadedBaseColor(readQual, baseColor)
                            }

                            blockBasesToDraw.push({
                                bbox: {
                                    x: xPixel,
                                    y: y,
                                    width: widthPixel,
                                    height: alignmentHeight
                                },
                                baseColor,
                                readChar,
                            })
                        }

                    }
                }

                return blockBasesToDraw
            }

            function renderBlockOrReadChar(context, bpp, bbox, color, char) {
                var threshold,
                    center

                threshold = 1.0 / 10.0
                if (bpp <= threshold && bbox.height >= 8) {

                    // render letter
                    const fontHeight = Math.min(10, bbox.height)
                    context.font = '' + fontHeight + 'px sans-serif'
                    center = bbox.x + (bbox.width / 2.0)
                    IGVGraphics.strokeText(context, char, center - (context.measureText(char).width / 2), fontHeight - 1 + bbox.y, {strokeStyle: color})
                } else {

                    // render colored block
                    IGVGraphics.fillRect(context, bbox.x, bbox.y, bbox.width, bbox.height, {fillStyle: color})
                }
            }
        }

    };

    popupData(clickState) {
        const clickedObject = this.getClickedObject(clickState)
        return clickedObject?.popupData(clickState.genomicLocation, this.hiddenTags, this.showTags)
    };

    /**
     * Return menu items for the AlignmentTrack
     *
     * NOTE: click handler functions are called in the context of the parent BAMTrack, thus the rather odd looking
     * reference to "this.alignmentTrack" in click handler function scopes.
     *
     * @returns {*[]}
     */
    menuItemList() {

        // Start with overage track items
        let menuItems = []

        // Color by items //////////////////////////////////////////////////
        menuItems.push('<hr/>')
        let element = createElementWithString('<div class="igv-track-menu-category">')
        element.innerText = 'Color by:'
        menuItems.push({name: undefined, element, click: undefined, init: undefined})

        const colorByMenuItems = []
        colorByMenuItems.push({key: 'none', label: 'none'})
        colorByMenuItems.push({key: 'strand', label: 'read strand'})
        if (this.hasPairs) {
            colorByMenuItems.push({key: 'firstOfPairStrand', label: 'first-of-pair strand'})
            colorByMenuItems.push({key: 'pairOrientation', label: 'pair orientation'})
            colorByMenuItems.push({key: 'tlen', label: 'insert size (TLEN)'})
            colorByMenuItems.push({key: 'unexpectedPair', label: 'pair orientation & insert size (TLEN)'})
        }
        if(this.colorBy && this.colorBy.startsWith("tag:")) {
            colorByMenuItems.push({key: this.colorBy, label: this.colorBy})
        }
        colorByMenuItems.push({key: 'tag', label: 'tag...'})
        for (let item of colorByMenuItems) {
            const selected = (this.colorBy === undefined && item.key === 'none') || this.colorBy === item.key
            menuItems.push(this.colorByCB(item, selected))
        }


        const size = this._baseModifications.size
        if (size > 0) {
            menuItems.push('<hr style="border-top:1px dotted;border-bottom: none;">')
            let label = size === 1 ? 'base modification' : 'base modification (all)'
            menuItems.push(this.basemodColorByCB({
                key: 'basemod', label
            }))
            if (size > 1) {
                for (let m of this._baseModifications) {
                    let key =
                        menuItems.push(this.basemodColorByCB({
                            key: 'basemod:' + m,
                            label: `base modification (${modificationName(m)})`
                        }))
                }
            }

            menuItems.push('<hr style="border-top:1px dotted;border-bottom: none;">')
            label = size === 1 ? 'base modification 2-color' : 'base modification 2-color (all)'
            menuItems.push(this.basemodColorByCB({
                key: 'basemod2', label
            }))
            if (size > 1) {
                for (let m of this._baseModifications) {
                    menuItems.push(this.basemodColorByCB({
                        key: 'basemod2:' + m,
                        label: `base modification 2-color (${modificationName(m)})`
                    }))
                }
            }
        }

        // Group by items //////////////////////////////////////////////////
        menuItems.push('<hr/>')
        element = document.createElement('div')
        element.className = 'igv-track-menu-category'
        element.textContent = 'Group by:'
        menuItems.push({name: undefined, element, click: undefined, init: undefined})

        const groupByMenuItems = []
        groupByMenuItems.push({key: 'none', label: 'none'})
        groupByMenuItems.push({key: 'strand', label: 'read strand'})
        if (this.hasPairs) {
            groupByMenuItems.push({key: 'firstOfPairStrand', label: 'first-of-pair strand'})
            groupByMenuItems.push({key: 'pairOrientation', label: 'pair orientation'})
            groupByMenuItems.push({key: 'mateChr', label: 'chromosome of mate'})
        }
        groupByMenuItems.push({key: 'chimeric', label: 'chimeric'})
        groupByMenuItems.push({key: 'supplementary', label: 'supplementary flag'})
        groupByMenuItems.push({key: 'readOrder', label: 'read order'})
        //groupByMenuItems.push({key: 'phase', label: 'phase'})

        for (let groupByTag of this._groupByTags) {
            groupByMenuItems.push({key: `tag:${groupByTag}`, label: `tag:${groupByTag}`})
        }
        for (let groupByPos of this._groupByPositions) {
            groupByMenuItems.push({key: `base:${groupByPos}`, label: `base:${groupByPos}`})
        }

        groupByMenuItems.push({key: 'tag', label: 'tag...'})

        for (let item of groupByMenuItems) {
            const selected = (this.groupBy === undefined && item.key === 'none') || this.groupBy === item.key
            menuItems.push(this.groupByCB(item, selected))
        }

        // Show all bases
        menuItems.push('<hr/>')
        menuItems.push({
            element: createCheckbox("Show all bases", this.showAllBases),
            click: function showAllBasesHandler() {
                this.alignmentTrack.showAllBases = !this.alignmentTrack.showAllBases
                this.trackView.repaintViews()
            }
        })

        // Show mismatches
        menuItems.push({
            element: createCheckbox("Show mismatches", this.showMismatches),
            click: function showMismatchesHandler() {
                this.alignmentTrack.showMismatches = !this.alignmentTrack.showMismatches
                this.trackView.repaintViews()
            }
        })

        // Insertions
        menuItems.push({
            element: createCheckbox("Show insertions", this.showInsertions),
            click: function showInsertionsHandler() {
                this.alignmentTrack.showInsertions = !this.alignmentTrack.showInsertions
                this.trackView.repaintViews()
            }
        })

        // Soft clips
        menuItems.push({
            element: createCheckbox("Show soft clips", this.showSoftClips),
            click: function showSoftClipsHandler() {
                this.alignmentTrack.showSoftClips = !this.alignmentTrack.showSoftClips
                const alignmentContainers = this.getCachedAlignmentContainers()
                for (let ac of alignmentContainers) {
                    ac.pack(this)
                }
                this.trackView.repaintViews()
            }
        })

        // View as pairs
        if (this.hasPairs) {
            menuItems.push('<hr/>')
            menuItems.push({
                element: createCheckbox("View as pairs", this.viewAsPairs),
                click: function viewAsPairsHandler() {
                    const b = !this.alignmentTrack.viewAsPairs
                    if (b && this.groupBy && !pairCompatibleGroupOptions.has(this.groupBy)) {
                        this.browser.alert.present(`'View as Pairs' is incompatible with 'Group By ${this.groupBy}'`)
                        return
                    }
                    this.alignmentTrack.viewAsPairs = b
                    const alignmentContainers = this.getCachedAlignmentContainers()
                    for (let ac of alignmentContainers) {
                        ac.pack(this)
                    }
                    this.trackView.checkContentHeight()
                    this.trackView.repaintViews()
                }
            })
        }

        // Add chords to JBrowse circular view, if present
        if (this.browser.circularView &&
            (this.hasPairs || this.hasSupplemental)) {
            menuItems.push('<hr/>')
            if (this.hasPairs) {
                menuItems.push({
                    label: 'Add discordant pairs to circular view',
                    click: function discordantPairsHandler() {
                        for (let viewport of this.trackView.viewports) {
                            this.addPairedChordsForViewport(viewport)
                        }
                    }
                })
            }
            if (this.hasSupplemental) {
                menuItems.push({
                    label: 'Add split reads to circular view',
                    click: function splitReadsHandler() {
                        for (let viewport of this.trackView.viewports) {
                            this.addSplitChordsForViewport(viewport)
                        }
                    }
                })
            }
        }


        // Display mode
        menuItems.push('<hr/>')

        element = document.createElement('div')
        element.className = 'igv-track-menu-category'
        element.textContent = 'Display mode:'
        menuItems.push({name: undefined, element, click: undefined, init: undefined})

        for (let mode of ["EXPANDED", "SQUISHED", "FULL"])
            menuItems.push({
                element: createCheckbox(mode.toLowerCase(), this.displayMode === mode),
                click: function expandHandler() {
                    this.alignmentTrack.setDisplayMode(mode)
                }
            })

        return menuItems
    }

    setDisplayMode(mode) {
        const repack = "FULL" === this.displayMode || "FULL" === mode
        this.displayMode = mode
        if (repack) {
            const alignmentContainers = this.getCachedAlignmentContainers()
            for (let ac of alignmentContainers) {
                ac.pack(this)
            }
        }
        this.trackView.checkContentHeight()
        this.trackView.repaintViews()
    }

    /**
     * Create a "color by" checkbox menu item, optionally initially checked
     *
     * NOTE: click handler functions are called in the context of the parent BAMTrack, thus the rather odd looking
     * reference to "this.alignmentTrack".
     *
     * @param menuItem
     * @param showCheck
     */
    colorByCB(menuItem, showCheck) {

        const element = createCheckbox(menuItem.label, showCheck)

        if (menuItem.key !== 'tag') {

            function clickHandler() {
                this.alignmentTrack.colorBy = menuItem.key
                this.trackView.repaintViews()
            }

            return {name: undefined, element, click: clickHandler, init: undefined}
        } else {

            function dialogPresentationHandler(ev) {

                const tag = this.alignmentTrack.colorBy.startsWith("tag:") ? this.alignmentTrack.colorBy.substring(4) : ''

                this.browser.inputDialog.present({
                    label: 'Tag Name',
                    value: tag,
                    callback: (tag) => {
                        const alignmentTrack = this.alignmentTrack
                        if (tag) {
                            alignmentTrack.colorBy = 'tag:' + tag
                            if (!alignmentTrack.colorTable) {
                                alignmentTrack.colorTable = new PaletteColorTable("Set1")
                            }
                        } else {
                            alignmentTrack.colorBy = undefined
                        }
                        this.trackView.repaintViews()
                    }
                }, ev)
            }

            return {name: undefined, element, dialog: dialogPresentationHandler, init: undefined}

        }
    }

    basemodColorByCB(menuItem) {

        const showCheck = this.colorBy === menuItem.key

        function clickHandler() {
            this.alignmentTrack.colorBy = menuItem.key
            this.trackView.repaintViews()
        }

        return {
            name: undefined,
            element: createCheckbox(menuItem.label, showCheck),
            click: clickHandler,
            init: undefined
        }
    }


    /**
     * Create a "group by" checkbox menu item, optionally initially checked.
     *
     * NOTE: click handler functions are called in the context of the parent BAMTrack, thus the rather odd looking
     * reference to "this.alignmentTrack".
     *
     * @param menuItem
     * @param showCheck
     */
    groupByCB(menuItem, showCheck) {

        function clickHandler(ev) {

            const doGroupBy = () => this.alignmentTrack.repackAlignments()

            if (menuItem.key === 'tag') {
                let currentTag = ''
                if (this.alignmentTrack.groupBy && this.alignmentTrack.groupBy.startsWith('tag:')) {
                    currentTag = this.alignmentTrack.groupBy.substring(4)
                }

                this.browser.inputDialog.present({
                    label: 'Tag Name',
                    value: currentTag,
                    callback: (tag) => {
                        if (tag) {
                            this.alignmentTrack.groupBy = 'tag:' + tag
                            this.alignmentTrack._groupByTags.push(tag)
                            doGroupBy()
                        }
                    }
                }, ev)
            } else {

                if (menuItem.key === 'none') {
                    this.alignmentTrack.groupBy = undefined
                } else {
                    this.alignmentTrack.groupBy = menuItem.key
                }
                doGroupBy()
            }
        }

        return {
            name: undefined,
            element: createCheckbox(menuItem.label, showCheck),
            dialog: clickHandler,
            init: undefined
        }

    }

    repackAlignments() {
        const alignmentContainers = this.getCachedAlignmentContainers()
        for (let ac of alignmentContainers) {
            if (typeof ac.pack === 'function') ac.pack(this)
        }
        this.trackView.checkContentHeight()
        this.trackView.repaintViews()
    }


    contextMenuItemList(clickState) {

        const viewport = clickState.viewport
        const list = []

        const sortByOption = (option) => {
            const cs = this.sortObject
            const direction = (cs && cs.position === Math.floor(clickState.genomicLocation)) ? !cs.direction : true
            const newSortObject = {
                chr: viewport.referenceFrame.chr,
                position: Math.floor(clickState.genomicLocation),
                option: option,
                direction: direction,
                sortAsPairs: viewport.trackView.track.viewAsPairs
            }
            this.sortObject = newSortObject
            viewport.cachedFeatures.sortRows(newSortObject)
            viewport.repaint()
        }
        list.push('<b>Sort by...</b>')
        list.push({label: '&nbsp; base', click: () => sortByOption("BASE")})
        list.push({label: '&nbsp; read strand', click: () => sortByOption("strand")})
        list.push({label: '&nbsp; start location', click: () => sortByOption("START")})
        list.push({label: '&nbsp; insert size', click: () => sortByOption("INSERT_SIZE")})
        list.push({label: '&nbsp; gap size', click: () => sortByOption("GAP_SIZE")})
        list.push({label: '&nbsp; chromosome of mate', click: () => sortByOption("MATE_CHR")})
        list.push({label: '&nbsp; mapping quality', click: () => sortByOption("MQ")})
        list.push({label: '&nbsp; read name', click: () => sortByOption("READ_NAME")})
        list.push({label: '&nbsp; aligned read length', click: () => sortByOption("ALIGNED_READ_LENGTH")})
        list.push({
            label: '&nbsp; tag', click: () => {
                const cs = this.sortObject
                const direction = (cs && cs.position === Math.floor(clickState.genomicLocation)) ? !cs.direction : true
                const config =
                    {
                        label: 'Tag Name',
                        value: this.sortByTag ? this.sortByTag : '',
                        callback: (tag) => {
                            if (tag) {
                                const newSortObject = {
                                    chr: viewport.referenceFrame.chr,
                                    position: Math.floor(clickState.genomicLocation),
                                    option: "TAG",
                                    tag: tag,
                                    direction: direction
                                }
                                this.sortByTag = tag
                                this.sortObject = newSortObject
                                viewport.cachedFeatures.sortRows(newSortObject)
                                viewport.repaint()
                            }
                        }
                    }
                this.browser.inputDialog.present(config, clickState.event)
            }
        })
        list.push('<hr/>')

        // Positional group by options
        const position = `${viewport.referenceFrame.chr}:${StringUtils.numberFormatter(Math.floor(clickState.genomicLocation) + 1)}`
        list.push({
            label: `Group by base @${position}`,
            click: () => {
                this._groupByPositions.push(position)
                this.groupBy = `base:${position}`
                const alignmentContainers = this.getCachedAlignmentContainers()
                for (let ac of alignmentContainers) {
                    ac.pack(this)
                }
                this.trackView.checkContentHeight()
                this.trackView.repaintViews()
            }
        })
        list.push('<hr/>')


        const clickedObject = this.getClickedObject(clickState)

        if (clickedObject) {

            const showSoftClips = this.showSoftClips
            const clickedAlignment = (typeof clickedObject.alignmentContaining === 'function') ?
                clickedObject.alignmentContaining(clickState.genomicLocation, showSoftClips) :
                clickedObject
            if (clickedAlignment) {
                if (clickedAlignment.isPaired() && clickedAlignment.isMateMapped()) {
                    list.push({
                        label: 'View mate in split screen',
                        click: () => {
                            if (clickedAlignment.mate) {
                                const referenceFrame = clickState.viewport.referenceFrame
                                const chromosomeObject = this.browser.genome.getChromosome(clickedAlignment.mate.chr)
                                if (chromosomeObject) {
                                    this.selectedReadName = clickedAlignment.readName
                                    //this.browser.presentMultiLocusPanel(clickedAlignment, referenceFrame)
                                    const bpWidth = referenceFrame.bpPerPixel * clickState.viewport.getWidth()
                                    const frameStart = clickedAlignment.mate.position - bpWidth / 2
                                    const frameEnd = clickedAlignment.mate.position + bpWidth / 2
                                    this.browser.addMultiLocusPanel(chromosomeObject.name, frameStart, frameEnd, referenceFrame)
                                } else {
                                    this.browser.alert.present(`Reference does not contain chromosome: ${clickedAlignment.mate.chr}`)
                                }
                            }
                        },
                        init: undefined
                    })
                }

                list.push('<hr/>')
                const softClips = clickedAlignment.softClippedBlocks()
                list.push({
                    label: 'View read sequence',
                    click: () => {
                        const seqstring = clickedAlignment.seq
                        this.browser.alert.present(seqstring && seqstring !== "*" ? seqstring : "Read sequence: *")
                    }
                })

                if (softClips.left && softClips.left.len > 0) {
                    list.push({
                        label: 'View left soft-clipped sequence',
                        click: () => {
                            const clippedSequence = clickedAlignment.seq.substring(softClips.left.seqOffset, softClips.left.seqOffset + softClips.left.len)
                            this.browser.alert.present(clippedSequence)
                        }
                    })
                }

                if (softClips.right && softClips.right.len > 0) {
                    list.push({
                        label: 'View right soft-clipped sequence',
                        click: () => {
                            const clippedSequence = clickedAlignment.seq.substring(softClips.right.seqOffset, softClips.right.seqOffset + softClips.right.len)
                            this.browser.alert.present(clippedSequence)
                        }
                    })
                }

                list.push('<hr/>')

                if (isSecureContext()) {
                    list.push({
                        label: 'Copy read sequence',
                        click: async () => {
                            try {
                                await navigator.clipboard.writeText(clickedAlignment.seq)
                            } catch (e) {
                                console.error(e)
                                this.browser.alert.present(`error copying sequence to clipboard ${e}`)
                            }
                        }
                    })

                    if (softClips.left && softClips.left.len > 0) {
                        list.push({
                            label: 'Copy left soft-clipped sequence',
                            click: async () => {
                                try {
                                    const clippedSequence = clickedAlignment.seq.substring(softClips.left.seqOffset, softClips.left.seqOffset + softClips.left.len)
                                    await navigator.clipboard.writeText(clippedSequence)
                                } catch (e) {
                                    console.error(e)
                                    this.browser.alert.present(`error copying sequence to clipboard ${e}`)
                                }
                            }
                        })
                    }

                    if (softClips.right && softClips.right.len > 0) {
                        list.push({
                            label: 'Copy right soft-clipped sequence',
                            click: async () => {
                                try {
                                    const clippedSequence = clickedAlignment.seq.substring(softClips.right.seqOffset, softClips.right.seqOffset + softClips.right.len)
                                    await navigator.clipboard.writeText(clippedSequence)
                                } catch (e) {
                                    console.error(e)
                                    this.browser.alert.present(`error copying sequence to clipboard ${e}`)
                                }
                            }
                        })
                    }
                }

                // TODO test if genome supports blat
                const seqstring = clickedAlignment.seq
                if (seqstring && "*" !== seqstring) {

                    list.push('<hr/>')

                    if (seqstring.length < maxSequenceSize) {
                        list.push({
                            label: 'BLAT visible sequence',
                            click: () => {
                                const sequence = clickedAlignment.isNegativeStrand() ? reverseComplementSequence(seqstring) : seqstring
                                const name = `${clickedAlignment.readName} - blat`
                                const title = `${this.name} - ${name}`
                                createBlatTrack({sequence, browser: this.browser, name, title})
                            }
                        })
                    }

                    const softClips = clickedAlignment.softClippedBlocks()
                    if (softClips.left && softClips.left.len > MINIMUM_BLAT_LENGTH && softClips.left.len < maxSequenceSize) {
                        list.push({
                            label: 'BLAT left soft-clipped sequence',
                            click: () => {
                                const clippedSequence = seqstring.substring(softClips.left.seqOffset, softClips.left.seqOffset + softClips.left.len)
                                const sequence = clickedAlignment.isNegativeStrand() ? reverseComplementSequence(clippedSequence) : clippedSequence
                                const name = `${clickedAlignment.readName} - blat left clip`
                                const title = `${this.name} - ${name}`
                                createBlatTrack({sequence, browser: this.browser, name, title})
                            }
                        })
                    }
                    if (softClips.right && softClips.right.len > MINIMUM_BLAT_LENGTH && softClips.right.len < maxSequenceSize) {
                        list.push({
                            label: 'BLAT right soft-clipped sequence',
                            click: () => {
                                const clippedSequence = seqstring.substring(softClips.right.seqOffset, softClips.right.seqOffset + softClips.right.len)
                                const sequence = clickedAlignment.isNegativeStrand() ? reverseComplementSequence(clippedSequence) : clippedSequence
                                const name = `${clickedAlignment.readName} - blat right clip`
                                const title = `${this.name} - ${name}`
                                createBlatTrack({sequence, browser: this.browser, name, title})
                            }
                        })
                    }
                }

                list.push('<hr/>')
            }
        }

        // Experimental JBrowse feature
        if (this.browser.circularView && (this.hasPairs || this.hasSupplemental)) {
            if (this.hasPairs) {
                list.push({
                    label: 'Add discordant pairs to circular view',
                    click: () => {
                        this.addPairedChordsForViewport(viewport)
                    }
                })
            }
            if (this.hasSupplemental) {
                list.push({
                    label: 'Add split reads to circular view',
                    click: () => {
                        this.addSplitChordsForViewport(viewport)
                    }
                })
            }
            list.push('<hr/>')
        }

        return list

    }

    getClickedObject(clickState) {

        const viewport = clickState.viewport
        let features = viewport.cachedFeatures
        if (!features) return

        const y = clickState.y
        const offsetY = y - this.top
        const genomicLocation = clickState.genomicLocation

        if (features.packedGroups) {
            let minGroupY = Number.MAX_VALUE
            for (let group of features.packedGroups.values()) {
                minGroupY = Math.min(minGroupY, group.pixelTop)
                if (offsetY > group.pixelTop && offsetY <= group.pixelBottom) {

                    const alignmentRowHeight = this.displayMode === "SQUISHED" ?
                        this.squishedRowHeight :
                        this.alignmentRowHeight

                    let packedAlignmentsIndex = Math.floor((offsetY - group.pixelTop) / alignmentRowHeight)

                    if (packedAlignmentsIndex >= 0 && packedAlignmentsIndex < group.length) {
                        const alignmentRow = group.rows[packedAlignmentsIndex]
                        const clicked = alignmentRow.alignments.filter(alignment => alignment.containsLocation(genomicLocation, this.showSoftClips))
                        if (clicked.length > 0) return clicked[0]
                    }
                }
            }
        }

        // If we get here check downsampled intervals
        if (offsetY < minGroupY && features.downsampledIntervals) {
            for (const interval of features.downsampledIntervals) {
                if (interval.start <= genomicLocation && interval.end >= genomicLocation) {
                    return interval
                }
            }
        }


    }

    /**
     * Return the color for connectors in paired alignment view.   If explicitly set return that, otherwise return
     * the alignment color, unless the color option can result in split colors (separte color for each mate).
     *
     * @param alignment
     * @returns {string}
     */
    getConnectorColor(alignment) {

        if (this.pairConnectorColor) {
            return this.pairConnectorColor
        }

        let colorBy = this.colorBy
        let tag
        if (colorBy && colorBy.startsWith("tag:")) {
            tag = colorBy.substring(4)
            colorBy = "tag"
        }

        switch (colorBy) {
            case "strand":
            case "firstOfPairStrand":
            case "pairOrientation":
            case "tag":
                if (this.color) {
                    return (typeof this.color === "function") ? this.color(alignment) : this.color
                } else {
                    return DEFAULT_CONNECTOR_COLOR
                }
            default:
                return this.getAlignmentColor(alignment)

        }
    }

    getAlignmentColor(alignment) {

        let color
        if (this.color) {
            color = (typeof this.color === "function") ? this.color(alignment) : this.color
        } else {
            color = DEFAULT_ALIGNMENT_COLOR
        }

        let colorBy = this.colorBy
        let tag
        if (colorBy && colorBy.startsWith("tag:")) {
            tag = colorBy.substring(4)
            colorBy = "tag"
        }
        switch (colorBy) {

            case "basemod":
            case "basemod2":
                color = alignment.strand ? this.baseModPosStrandColor : this.baseModNegStrandColor
                break
            case "strand":
                color = alignment.strand ? this.posStrandColor : this.negStrandColor
                break

            case "firstOfPairStrand":
                const s = alignment.firstOfPairStrand
                if (s !== undefined) {
                    color = s ? this.posStrandColor : this.negStrandColor
                }
                break

            case "unexpectedPair":
            case "pairOrientation":

                if (alignment.pairOrientation) {
                    const oTypes = orientationTypes[this.expectedPairOrientation]
                    if (oTypes) {
                        const pairColor = this.pairColors[oTypes[alignment.pairOrientation]]
                        if (pairColor) {
                            color = pairColor
                            break
                        }
                    }
                }
                if ("pairOrientation" === colorBy) {
                    break
                }

            case "tlen":
            case "fragmentLength":

                if (alignment.mate && alignment.isMateMapped()) {
                    if (alignment.mate.chr !== alignment.chr) {
                        color = getChrColor(alignment.mate.chr)
                    } else if (this.minTemplateLength && Math.abs(alignment.fragmentLength) < this.minTemplateLength) {
                        color = this.smallTLENColor
                    } else if (this.maxTemplateLength && Math.abs(alignment.fragmentLength) > this.maxTemplateLength) {
                        color = this.largeTLENColor
                    }
                }
                break

            case "tag":
                const tagValue = alignment.tags()[tag]
                if (tagValue !== undefined) {

                    // If the tag value can be interpreted as a color, use it
                    if(typeof tagValue.startsWith === 'function') {
                        color = IGVColor.createColorStringSafe(tagValue)
                    }

                    // Tag value is not a color, use a color table
                    if (!color) {
                        if (!this.colorTable) {
                            this.colorTable = new PaletteColorTable(this.tagColorPallete)
                        }
                        color = this.colorTable.getColor(tagValue)
                    }
                }
                break
        }

        return color

    }

    get nucleotideColors() {
        return this.browser.nucleotideColors
    }


    get minTemplateLength() {
        return (this.minTLEN !== undefined) ? this.minTLEN :
            this.parent._pairedEndStats ? this.parent._pairedEndStats.minTLEN : 0
    }

    get maxTemplateLength() {
        return (this.maxTLEN !== undefined) ? this.maxTLEN :
            this.parent._pairedEndStats ? this.parent._pairedEndStats.maxTLEN : 1000
    }

    getState() {
        const config = super.getState()
        if (this.highlightedReads) {
            config.highlightedReads = Array.from(this.highlightedReads)
        }
        return config
    }


    // Property delegates

    get name() {
        return this.parent.name
    }

    set name(nm) {
        this.parent.name = nm
    }

    get color() {
        return this.parent.color
    }

    set color(c) {
        this.parent.color = c
    }

    get trackView() {
        return this.parent.trackView
    }

    get getCachedAlignmentContainers() {
        return this.parent.getCachedAlignmentContainers
    }

    get sortObject() {
        return this.parent.sortObject
    }

    set sortObject(obj) {
        this.parent.sortObject = obj
    }

    addPairedChordsForViewport(viewport) {
        return this.parent.addPairedChordsForViewport(viewport)
    }

    addSplitChordsForViewport(viewport) {
        return this.parent.addSplitChordsForViewport(viewport)
    }

}

function shadedBaseColor(qual, baseColor) {

    const minQ = 5   //prefs.getAsInt(PreferenceManager.SAM_BASE_QUALITY_MIN),
    const maxQ = 20  //prefs.getAsInt(PreferenceManager.SAM_BASE_QUALITY_MAX);

    let alpha
    if (qual < minQ) {
        alpha = 0.1
    } else {
        alpha = Math.max(0.1, Math.min(1.0, 0.1 + 0.9 * (qual - minQ) / (maxQ - minQ)))
    }
    // Round alpha to nearest 0.1
    alpha = Math.round(alpha * 10) / 10.0

    if (alpha < 1) {
        baseColor = IGVColor.addAlpha(baseColor, alpha)
    }
    return baseColor
}

function locusChange() {
    if ("FULL" === this.displayMode && !this.browser.isTrackPanning()) {
        this.repackAlignments()
    }
}


export default AlignmentTrack
