// 自訂 Build 腳本：使用 esbuild 取代 Vite/Rollup (繞過 Node 24 原生模組崩潰)
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
    const distDir = resolve(__dirname, 'dist');
    const publicDir = resolve(__dirname, 'public');

    // 1. 清除舊的 dist
    if (existsSync(distDir)) {
        rmSync(distDir, { recursive: true, force: true });
    }
    mkdirSync(resolve(distDir, 'assets'), { recursive: true });

    // 2. 用 esbuild 打包 React 應用
    console.log('🔨 Building JS bundle with esbuild...');
    const result = await build({
        entryPoints: [resolve(__dirname, 'src/main.jsx')],
        bundle: true,
        minify: true,
        splitting: false,
        format: 'esm',
        outfile: resolve(distDir, 'assets/index.js'),
        jsx: 'automatic',
        define: {
            'process.env.NODE_ENV': '"production"',
            'import.meta.env.VITE_BACKEND_URL': 'undefined',
            'import.meta.env.MODE': '"production"',
            'import.meta.env.DEV': 'false',
            'import.meta.env.PROD': 'true',
            'import.meta.env.SSR': 'false',
            'import.meta.env.BASE_URL': '"/"',
        },
        loader: {
            '.js': 'jsx',
            '.jsx': 'jsx',
            '.css': 'empty',  // CSS 由 tailwind CLI 處理，這裡跳過
        },
        target: ['chrome107', 'firefox104', 'safari16'],
        sourcemap: false,
        metafile: true,
    });

    // 顯示打包大小
    for (const [file, info] of Object.entries(result.metafile.outputs)) {
        console.log(`  📦 ${file} - ${(info.bytes / 1024).toFixed(1)} kB`);
    }

    // 3. 複製 public/ 靜態檔案到 dist/
    console.log('📂 Copying public assets...');
    cpSync(publicDir, distDir, { recursive: true });

    // 4. 從 index.html 模板生成 dist/index.html
    console.log('📄 Generating index.html...');
    let html = readFileSync(resolve(__dirname, 'index.html'), 'utf-8');

    // 移除 Vite 開發用的 script tag，替換成打包後的
    html = html.replace(
        '<script type="module" src="/src/main.jsx"></script>',
        '<script type="module" src="/assets/index.js"></script>'
    );

    writeFileSync(resolve(distDir, 'index.html'), html, 'utf-8');

    console.log('✅ Build 完成！輸出至 dist/');
}

main().catch(err => {
    console.error('❌ Build 失敗:', err);
    process.exit(1);
});
