import { readFile, writeFile } from 'fs/promises';
import { analyzeImage } from './src/services/vision-analysis.js';
import { extractElements } from './src/services/element-extraction.js';
import { updateCorpusEntry } from './src/services/image-corpus.js';
import { join } from 'path';
import { homedir } from 'os';
import sharp from 'sharp';
import { jxl } from 'icodec/node';

const IMAGES_DIR = join(homedir(), '.quje-agent', 'images');

// Load corpus
const { getCorpus } = await import('./src/services/image-corpus.js');
const corpus = await getCorpus();
const entries = Array.from(corpus.values());

// Find generated images without elements
const needsBackfill = entries.filter(e => 
  e.type === 'generated' && 
  (!e.elements || Object.keys(e.elements).length === 0)
);

console.log(`Found ${needsBackfill.length} generated images needing backfill\n`);

for (const entry of needsBackfill) {
  console.log(`Processing: ${entry.id.slice(0, 8)}...`);
  
  // Use imagePath to find the image folder
  const imageDir = join(IMAGES_DIR, entry.imagePath);
  const jxlPath = join(imageDir, 'image.jxl');
  const pngPath = join(imageDir, 'image.png');
  
  let pngBuffer;
  try {
    // Load JXL
    const jxlBuffer = await readFile(jxlPath);
    console.log('  Loaded JXL');
    
    // Decode JXL using icodec (same pattern as image-storage.ts)
    await jxl.loadDecoder();
    const image = await sharp(jxlBuffer).ensureAlpha().toBuffer({ resolveWithObject: true });
    const rawBuffer = await sharp(jxlBuffer).ensureAlpha().raw().toBuffer();
    
    const imageData = {
      width: image.info.width,
      height: image.info.height,
      data: new Uint8ClampedArray(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength),
      depth: 8
    };
    
    pngBuffer = await sharp(imageData, {
      raw: {
        width: imageData.width,
        height: imageData.height,
        channels: 4
      }
    }).png().toBuffer();
    
    // Save PNG for future use
    await writeFile(pngPath, pngBuffer);
    console.log(`  ✓ Converted JXL → PNG (${imageData.width}x${imageData.height})`);
  } catch (err) {
    console.log(`  ✗ Conversion failed: ${err.message}`);
    continue;
  }
  
  // Convert to base64
  const base64 = pngBuffer.toString('base64');
  
  // Analyze with z-image preset
  console.log('  Analyzing with z-image...');
  try {
    const analysis = await analyzeImage(base64, 'z_image');
    console.log(`  ✓ Description: ${analysis.description.length} chars`);
    
    // Extract elements from description
    console.log('  Extracting elements...');
    const elements = await extractElements(analysis.description, entry.prompt);
    
    if (Object.keys(elements).length > 0) {
      // Update corpus entry
      await updateCorpusEntry(entry.id, {
        description: analysis.description,
        elements,
        updatedAt: Date.now(),
      });
      console.log(`  ✓ Elements: ${Object.keys(elements).length} categories`);
      
      // Print first few categories
      const cats = Object.keys(elements);
      console.log(`    Categories: ${cats.join(', ')}`);
    } else {
      console.log('  ✗ Element extraction returned empty');
    }
  } catch (err) {
    console.log(`  ✗ Analysis failed: ${err.message}`);
  }
  
  console.log();
}

console.log('✓ Backfill complete!');
