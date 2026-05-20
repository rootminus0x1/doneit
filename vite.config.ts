import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import mime from 'mime-types'; // Import mime-types for proper content type detection
import { readdirSync, statSync, createReadStream, existsSync } from 'fs';
import { join } from 'path';

// Serves the local DoneIt/ directory at /local-data/ with directory listing.
// Only registered when running vite --mode localdata.
function serveLocalData(): Plugin {
    return {
        name: 'serve-local-data',
        configureServer(server) {
            // Middleware to serve local data from the 'DoneIt' directory
            server.middlewares.use('/local-data', (req, res, next) => {
                const urlPath = decodeURIComponent((req.url ?? '/').replace(/\?.*$/, '')).replace(/^\/+/, '');
                const fsPath = join(process.cwd(), 'DoneIt', urlPath);

                if (!existsSync(fsPath)) {
                    res.statusCode = 404;
                    res.end('Not found');
                    console.warn(`Local data not found: ${fsPath}`); // Log missing files
                    return;
                }

                try {
                    const s = statSync(fsPath);
                    // If it's a directory, return a JSON listing of its contents
                    if (s.isDirectory()) {
                        const entries = readdirSync(fsPath).map(name => ({
                            name,
                            type: statSync(join(fsPath, name)).isDirectory() ? 'directory' : 'file',
                        }));
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify(entries));
                    } else {
                        // If it's a file, stream its content with appropriate MIME type
                        const contentType = mime.lookup(fsPath) || 'application/octet-stream';
                        res.setHeader('Content-Type', contentType);
                        createReadStream(fsPath).pipe(res);
                    }
                } catch (e) {
                    console.error(`Error serving local data from ${fsPath}:`, e); // Log errors
                    next(e);
                }
            });
        },
    };
}

export default defineConfig(({ mode }) => {
    const BASE_PATH = '/doneit/'; // Define base path once
    return {
        base: BASE_PATH,
        define: {
            // Injects the build timestamp into the application for versioning or debugging.
            __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
        },
        plugins: [
            react(),
            mode === 'localdata' && serveLocalData(),
            VitePWA({
                registerType: 'autoUpdate',
                manifest: {
                    name: 'Done It',
                    short_name: 'Done It',
                    description: 'Personal hiking track viewer',
                    theme_color: '#1a73e8',
                    background_color: '#ffffff',
                    display: 'standalone',
                    start_url: BASE_PATH, // Use the defined base path
                    icons: [
                        { src: `${BASE_PATH}icon-192.png`, sizes: '192x192', type: 'image/png' },
                        { src: `${BASE_PATH}icon-512.png`, sizes: '512x512', type: 'image/png' },
                    ],
                },
            }),
        ],
    };
});
