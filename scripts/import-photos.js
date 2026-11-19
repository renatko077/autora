// Run with reviewed JSON photo mappings. No website credentials are required.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const cache = path.join(root, 'tmp', 'photo-import');
fs.mkdirSync(cache, {recursive:true});
const files = process.argv.slice(2).filter(arg=>arg!=='--download-only');
const downloadOnly = process.argv.includes('--download-only');
if (!files.length) throw new Error('Pass one or more reviewed JSON source mappings.');
const records = files.flatMap(file=>{
  const value = JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
  return Array.isArray(value) ? value : Object.values(value);
}).map(record=>({...record,image_url:record.source_image_url || record.image_url}));
const sources = [...new Map(records.filter(r=>r.image_url).map(r=>[r.image_url,r])).values()];
for (const source of sources) {
  const image = new URL(source.image_url), page = new URL(source.source_url);
  if (!/^content\d?\.rozetka\.com\.ua$/.test(image.hostname) || !image.pathname.startsWith('/goods/images/')) throw new Error(`Invalid image origin: ${source.image_url}`);
  if (!/(^|\.)rozetka\.com\.ua$/.test(page.hostname) || !/\/p\d+\//.test(page.pathname)) throw new Error(`Invalid product page: ${source.source_url}`);
}

async function download(source) {
  const key=crypto.createHash('sha256').update(source.image_url).digest('hex').slice(0,20);
  const rawPath=path.join(cache,`${key}.image`);
  if (!fs.existsSync(rawPath)) {
    let failure;
    for (let attempt=0;attempt<3;attempt++) {
      try {
        const response=await fetch(source.image_url,{signal:AbortSignal.timeout(25000)});
        if(!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error(`Image HTTP ${response.status}`);
        const buffer=Buffer.from(await response.arrayBuffer());
        if(buffer.length<1000 || buffer.length>15*1024*1024) throw new Error(`Unexpected image size: ${buffer.length}`);
        fs.writeFileSync(rawPath,buffer);
        failure=null;break;
      }catch(error){failure=error;}
    }
    if(failure)throw new Error(`${source.image_url}: ${failure.message}`);
  }
  return {key,raw_path:rawPath,source_image_url:source.image_url,output_path:path.join(root,'public','assets','photos',`${key}.webp`)};
}

(async()=>{
  const queue=[...sources], downloaded=[], failures=[];
  await Promise.all(Array.from({length:5},async()=>{
    while(queue.length){const source=queue.shift();try{downloaded.push(await download(source));}catch(error){failures.push(error.message);}}
  }));
  if(failures.length)throw new Error(failures.join('\n'));
  const input=path.join(cache,'normalization-input.json');
  fs.writeFileSync(input,JSON.stringify(downloaded));
  execFileSync(process.env.PHOTO_PYTHON || 'python',[path.join(__dirname,'normalize-photos.py'),input],{stdio:'inherit'});
  const normalized=JSON.parse(fs.readFileSync(path.join(cache,'normalization-results.json'),'utf8'));
  const photoByUrl=new Map(normalized.map(photo=>[photo.source_image_url,photo]));
  if(downloadOnly){console.log(`Cached and normalized ${normalized.length} reviewed source photos.`);return;}
  const products=JSON.parse(fs.readFileSync(path.join(root,'data','products.json'),'utf8'));
  const previous=new Map(JSON.parse(fs.readFileSync(path.join(root,'data','product-images.json'),'utf8')).map(p=>[p.id,p]));
  const byId=new Map();
  for(const record of records){if(!Number.isInteger(record.id))throw new Error('Final mappings need integer product IDs.');if(byId.has(record.id))throw new Error(`Duplicate product ${record.id}`);byId.set(record.id,record);}
  const manifest=products.map(product=>{
    const record=byId.get(product.id);if(!record)throw new Error(`Missing photo mapping for ${product.id}`);
    const image=photoByUrl.get(record.image_url);if(!image)throw new Error(`Missing downloaded photo for ${product.id}`);
    const old=previous.get(product.id);
    return {id:product.id,image_url:`/assets/photos/${image.key}.webp`,source:'Rozetka',source_url:record.source_url,
      source_title:record.source_title,source_image_url:record.image_url,image_kind:'reference_photo',
      match_type:'type_reference',match_note:record.match_note || 'Фото відповідного типу товару. Точна модель у вихідному каталозі не вказана.',
      image_fallback_url:old?.image_fallback_url || (old?.image_kind==='illustration'?old.image_url:undefined),
      image_width:image.width,image_height:image.height};
  });
  fs.writeFileSync(path.join(root,'data','product-images.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(`Imported photos for all ${manifest.length} products from ${sources.length} reviewed Rozetka images.`);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
