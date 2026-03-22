import { readFile, writeFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { analyzeImage } from './src/services/vision-analysis.js';
import { extractElements } from './src/services/element-extraction.js';
import { embedPrompt } from './src/services/image-corpus.js';
import sharp from 'sharp';

const IMAGES_DIR = join(homedir(), '.quje-agent', 'images');
const VISION_DIR = join(homedir(), '.quje-agent', 'vision', 'images');
const CORPUS_FILE = join(homedir(), '.quje-agent', 'image-corpus', 'corpus.json');

const corpus = [];

console.log('=== Rebuilding Image Corpus ===\n');

// Scan generated images - use PNG if available, skip JXL-only
console.log('Scanning generated images...');
const imageIds = await readdir(IMAGES_DIR);
for (const id of imageIds.slice(0, 10)) {
  const imageDir = join(IMAGES_DIR, id);
  const pngPath = join(imageDir, 'image.png');
  const metaPath = join(imageDir, 'metadata.json');
  
  try {
    await access(pngPath); // Skip if no PNG
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    const pngBuffer = await readFile(pngPath);
    const base64 = pngBuffer.toString('base64');
    
    // Analyze
    console.log(`  ${id.slice(0,8)}... analyzing`);
    const analysis = await analyzeImage(base64, 'z_image');
    const elements = await extractElements(analysis.description, meta.params.positivePrompt);
    const embedding = await embedPrompt(meta.params.positivePrompt);
    
    corpus.push({
      id: `gen-${id}`,
      type: 'generated',
      imagePath: id,
      prompt: meta.params.positivePrompt,
      description: analysis.description,
      elements,
      promptEmbedding: embedding,
      createdAt: new Date(meta.createdAt).getTime(),
      updatedAt: Date.now(),
      generationId: id,
    });
    console.log(`    ✓ ${Object.keys(elements).length} element categories`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.log(`  ✗ ${id.slice(0,8)}: ${err.message}`);
    }
  }
}

// Scan vision analyses
console.log('\nScanning vision analyses...');
const visionIds = await readdir(VISION_DIR);
for (const id of visionIds.slice(0, 10)) {
  const metaPath = join(VISION_DIR, id, 'metadata.json');
  
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    const pngBuffer = await readFile(join(VISION_DIR, id, meta.filename));
    const base64 = pngBuffer.toString('base64');
    
    // Analyze
    console.log(`  ${id.slice(0,8)}... analyzing`);
    const analysis = await analyzeImage(base64, 'z_image');
    const elements = await extractElements(analysis.description);
    const embedding = await embedPrompt(analysis.description);
    
    corpus.push({
      id: `vis-${id}`,
      type: 'analyzed',
      imagePath: join('vision', 'images', id, meta.filename),
      thumbnailPath: join('vision', 'images', id, 'thumb.webp'),
      description: analysis.description,
      elements,
      promptEmbedding: embedding,
      createdAt: new Date(meta.createdAt).getTime(),
      updatedAt: Date.now(),
      visionId: id,
    });
    console.log(`    ✓ ${Object.keys(elements).length} element categories`);
  } catch (err) {
    console.log(`  ✗ ${id.slice(0,8)}: ${err.message}`);
  }
}

// Save corpus
await writeFile(CORPUS_FILE, JSON.stringify(corpus, null, 2));
console.log(`\n✓ Corpus rebuilt: ${corpus.length} entries`);
console.log(`  Generated: ${corpus.filter(e => e.type === 'generated').length}`);
console.log(`  Analyzed: ${corpus.filter(e => e.type === 'analyzed').length}`);
console.log(`  With embeddings: ${corpus.filter(e => e.promptEmbedding?.length).length}`);
console.log(`  With elements: ${corpus.filter(e => Object.keys(e.elements).length > 0).length}`);
