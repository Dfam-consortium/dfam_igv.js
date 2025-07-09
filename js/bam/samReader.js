import AlignmentContainer from "./alignmentContainer.js"
import BamUtils from "./bamUtils.js"
import {BGZip, FeatureCache, igvxhr} from "../../node_modules/igv-utils/src/index.js"
import {buildOptions, isDataURL} from "../util/igvUtils.js"

const SamReader = function (config, genome) {
    this.config = config
    this.genome = genome
    BamUtils.setReaderDefaults(this, config)
    this.url = config.url
    // TODO Support dataURI or JSON encoding
    // this.features = config.features
    this.header = null
    this.alignmentCache = null
}

SamReader.prototype.readAlignments = async function (chr, bpStart, bpEnd) {
    if (!this.alignmentCache) {
        let samData
        if ( this.url ) {
            samData = await igvxhr.loadString(this.url, buildOptions(this.config))
        }else {
            // TODO: Allow for dataURI or JSON encoding
            // if ( this.features ) {
            //   for feature in features
            //        samData += feature.readName + "\t"
            //        samData += feature.flags + "\t"
            //        samData += feature.chr + "\t"
            //        samData += feature.start + "\t" ...
            // ...process same-like JSON features into samData to reuse decodeSamRecords
            samData = "hg38:chr5\t16\tchr1\t3\t0\t40M8D3M3D4M8D5M1I41M1D13M1D4M1I25M3I89M3D10M\t*\t0\t0\tAGTATACCATAGTGATCAAGACCATGGCTTGTGGAGTAAGGATAATCACCACATTACATGATTTGTCATATTTAGTACTTTGCTTAACCTTAGTTCCCTCAGTTTCACATTGTTTAAAATGAGGTTAAAAATACTACATCCTGTCTTACAGGGTTGTTATAAAGGTTAAATTAATTTATGTTTCTAAAACATTGAAAACAATGCCTGCTACATTGTGAATAGTGTATAATTACTTATTA\t*\nhg38:chr17\t16\tchr1\t2\t0\t9M1D58M4D33M19I19M1D63M4I24M1D47M\t*\t0\t0\tCAGTGTGGTTAGTGGTTAGGGAAATGGACTTGAGAGCTGGACTGCCTGGGCTCAATTCTCAGCTCTGGTACTGGTCTCATGGCCTTGGGAAAGTGTTTTGTTGTTGTTGTTTTGTTTTTACATTTCTCTGCCTCAGTGCTTCTTCGGTAAAATGGGAATAAAAAGAGTAACTGTCTCATAAGATGACTGTGAGAATGAAATCAGTGAATTAATATGTACAAAGAGCTTAAACATCACTTGGAACATAGTAAGTGATATATGAGAGTCAGTTCTTAT\t*\nhg38:chr9\t0\tchr1\t3\t0\t37M1I22M1D16M7D7M19D43M3D16M1D67M1I21M\t*\t0\t0\tAGCATGGAATTATGGTTCAAGCCACACACCCTGGCACTTAGTCAACCTGGAGTCAAATCCAGCCCAGCCACGTACTTGACCTTTCTGTGCTTCTGTTTCCTTCTCTATAAAATGAGAATGAGGATATCTCTTTTACAGAGTTTTGTGAAGATTAAATGAGTGAATAAACATACAACACTTAGAACAATGCCTGGTACAGAAGAAGTGCTATATTAAGGACTGGCTATCACT\t*\n"
       }
    
        // Decode all records once and store
        const alignments = []
        BamUtils.decodeSamRecords(samData, alignments, chr, 0, Number.MAX_SAFE_INTEGER, this.filter)
        this.alignmentCache = new FeatureCache(alignments, this.genome)
    }

        const qAlignments = this.alignmentCache.queryFeatures(chr, bpStart, bpEnd)
        const alignmentContainer = new AlignmentContainer(chr, bpStart, bpEnd, this.config)
        for (let a of qAlignments) {
            alignmentContainer.push(a)
        }
        alignmentContainer.finish()
        return alignmentContainer
}

export default SamReader

