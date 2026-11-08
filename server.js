// Servidor de Pentu (Render + Backblaze B2).
// Los videos y su información se guardan en un bucket de Backblaze B2 (API S3),
// así que no se pierde nada cuando Render reinicia. El navegador sube el video
// directo al bucket con una URL firmada; este servidor solo reparte la web y firma.
// No hay clave de subida. Cada video tiene un código corto: /v/CODIGO

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    PutBucketCorsCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PORT = process.env.PORT || 3000;
const MAX_MB = 2048; // tamaño máximo por video (2 GB)
const SUBIDAS_POR_HORA = Number(process.env.SUBIDAS_POR_HORA || 10);

const TIPOS = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg'
};

// ---------- Backblaze B2 (compatible con S3) ----------

const { B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT } = process.env;
if (!B2_KEY_ID || !B2_APP_KEY || !B2_BUCKET || !B2_ENDPOINT) {
    console.error('Faltan variables: B2_KEY_ID, B2_APP_KEY, B2_BUCKET y B2_ENDPOINT.');
    process.exit(1);
}

// De https://s3.us-west-004.backblazeb2.com se saca la región us-west-004
const region = (B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || 'us-east-005';

const s3 = new S3Client({
    region,
    endpoint: B2_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
    // B2 no admite los checksums automáticos nuevos del SDK
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
});

// Permite que el navegador suba y lea directo desde el bucket
s3.send(
    new PutBucketCorsCommand({
        Bucket: B2_BUCKET,
        CORSConfiguration: {
            CORSRules: [
                {
                    AllowedOrigins: [process.env.ORIGEN_WEB || '*'],
                    AllowedMethods: ['GET', 'HEAD', 'PUT'],
                    AllowedHeaders: ['*'],
                    ExposeHeaders: ['ETag', 'Content-Range', 'Accept-Ranges'],
                    MaxAgeSeconds: 3600
                }
            ]
        }
    })
).catch((err) =>
    console.warn(
        'No se pudo configurar CORS automáticamente (configúralo en el panel de B2):',
        err.message
    )
);

const leerTexto = async (clave) => {
    const r = await s3.send(new GetObjectCommand({ Bucket: B2_BUCKET, Key: clave }));
    return r.Body.transformToString();
};
const guardarJSON = (clave, datos) =>
    s3.send(
        new PutObjectCommand({
            Bucket: B2_BUCKET,
            Key: clave,
            Body: JSON.stringify(datos),
            ContentType: 'application/json'
        })
    );
const borrar = (clave) =>
    s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: clave })).catch(() => {});
const existe = (clave) =>
    s3
        .send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key: clave }))
        .then((r) => r)
        .catch(() => null);

// ---------- Utilidades ----------

const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
const nuevoCodigo = () => {
    let c = '';
    for (const b of crypto.randomBytes(8)) c += ALFABETO[b % ALFABETO.length];
    return c;
};
const CODIGO_VALIDO = /^[a-z0-9]{8}$/;

const escapar = (t) =>
    String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Comprueba los primeros bytes del archivo ya subido
async function esVideoReal(clave, ext) {
    const r = await s3.send(
        new GetObjectCommand({ Bucket: B2_BUCKET, Key: clave, Range: 'bytes=0-11' })
    );
    const buf = Buffer.from(await r.Body.transformToByteArray());
    if (ext === '.mp4' || ext === '.m4v') return buf.toString('latin1', 4, 8) === 'ftyp';
    if (ext === '.webm') {
        return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    }
    if (ext === '.ogv') return buf.toString('latin1', 0, 4) === 'OggS';
    return false;
}

// Un video publicado es indice/CODIGO.json; el archivo está en videos/CODIGOext
async function buscarVideo(codigo) {
    if (!CODIGO_VALIDO.test(codigo)) return null;
    try {
        return JSON.parse(await leerTexto(`indice/${codigo}.json`));
    } catch {
        return null;
    }
}

// Lista de videos con una caché corta para no consultar el bucket en cada visita
let cacheLista = { hasta: 0, datos: [] };
async function listarVideos() {
    if (Date.now() < cacheLista.hasta) return cacheLista.datos;
    const r = await s3.send(
        new ListObjectsV2Command({ Bucket: B2_BUCKET, Prefix: 'indice/', MaxKeys: 1000 })
    );
    const recientes = (r.Contents || [])
        .sort((a, b) => b.LastModified - a.LastModified)
        .slice(0, 100);
    const videos = await Promise.all(
        recientes.map((o) =>
            leerTexto(o.Key)
                .then((t) => JSON.parse(t))
                .catch(() => null)
        )
    );
    const datos = videos
        .filter(Boolean)
        .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))
        .map(({ id, titulo, fecha }) => ({ id, titulo, fecha }));
    cacheLista = { hasta: Date.now() + 15000, datos };
    return datos;
}

// Límite de subidas por IP (no hay clave, esto evita abusos)
const subidasPorIP = new Map();
function limitarSubidas(req, res, next) {
    const ahora = Date.now();
    const recientes = (subidasPorIP.get(req.ip) || []).filter((t) => ahora - t < 3600000);
    if (recientes.length >= SUBIDAS_POR_HORA) {
        return res.status(429).json({ error: 'Demasiadas subidas, intenta más tarde' });
    }
    recientes.push(ahora);
    subidasPorIP.set(req.ip, recientes);
    next();
}
setInterval(() => {
    const ahora = Date.now();
    for (const [ip, marcas] of subidasPorIP) {
        if (marcas.every((t) => ahora - t >= 3600000)) subidasPorIP.delete(ip);
    }
}, 600000).unref();

// ---------- App ----------

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

// Lista de videos, los más nuevos primero
app.get('/api/videos', async (req, res) => {
    try {
        res.json(await listarVideos());
    } catch (err) {
        console.error('Error al listar:', err.message);
        res.status(500).json({ error: 'No se pudo leer la lista de videos' });
    }
});

// Paso 1 de la subida: se registra el video y se entrega una URL firmada
app.post('/api/videos/iniciar', limitarSubidas, async (req, res) => {
    try {
        const { titulo = '', nombre = '', tamano = 0 } = req.body || {};
        const ext = path.extname(String(nombre)).toLowerCase();
        if (!TIPOS[ext]) {
            return res.status(400).json({ error: 'Formato no permitido. Usa MP4, WebM u OGV.' });
        }
        if (!Number.isFinite(tamano) || tamano <= 0 || tamano > MAX_MB * 1024 * 1024) {
            return res.status(413).json({ error: `El video supera los ${MAX_MB} MB` });
        }

        const id = nuevoCodigo();
        await guardarJSON(`pendientes/${id}.json`, {
            id,
            titulo: String(titulo).trim().slice(0, 100) || 'Sin título',
            ext,
            fecha: new Date().toISOString()
        });

        const url = await getSignedUrl(
            s3,
            new PutObjectCommand({
                Bucket: B2_BUCKET,
                Key: `videos/${id}${ext}`,
                ContentType: TIPOS[ext]
            }),
            { expiresIn: 3 * 3600 }
        );
        res.json({ id, url, contentType: TIPOS[ext] });
    } catch (err) {
        console.error('Error al iniciar subida:', err.message);
        res.status(500).json({ error: 'No se pudo iniciar la subida' });
    }
});

// Paso 2: el navegador avisa que terminó; se comprueba y se publica
app.post('/api/videos/:id/confirmar', async (req, res) => {
    try {
        const id = req.params.id;
        if (!CODIGO_VALIDO.test(id)) return res.status(404).json({ error: 'Video no encontrado' });

        const publicado = await buscarVideo(id);
        if (publicado) {
            return res.json({ id, titulo: publicado.titulo, fecha: publicado.fecha });
        }

        let pendiente;
        try {
            pendiente = JSON.parse(await leerTexto(`pendientes/${id}.json`));
        } catch {
            return res.status(404).json({ error: 'Video no encontrado' });
        }

        const claveVideo = `videos/${id}${pendiente.ext}`;
        const descartar = async (codigo, mensaje) => {
            await borrar(claveVideo);
            await borrar(`pendientes/${id}.json`);
            return res.status(codigo).json({ error: mensaje });
        };

        const meta = await existe(claveVideo);
        if (!meta) return descartar(400, 'No se recibió el archivo');
        if (meta.ContentLength > MAX_MB * 1024 * 1024) {
            return descartar(413, `El video supera los ${MAX_MB} MB`);
        }
        if (!(await esVideoReal(claveVideo, pendiente.ext))) {
            return descartar(400, 'El archivo no parece ser un video válido');
        }

        const video = { ...pendiente, bytes: meta.ContentLength };
        await guardarJSON(`indice/${id}.json`, video);
        await borrar(`pendientes/${id}.json`);
        cacheLista.hasta = 0;

        console.log(`Video "${video.titulo}" publicado con código ${id}`);
        res.status(201).json({ id, titulo: video.titulo, fecha: video.fecha });
    } catch (err) {
        console.error('Error al confirmar:', err.message);
        res.status(500).json({ error: 'No se pudo completar la subida' });
    }
});

// Reproducir: se redirige a una URL firmada del bucket (soporta adelantar/retroceder)
app.get('/api/videos/:id/archivo', async (req, res) => {
    try {
        const v = await buscarVideo(req.params.id);
        if (!v) return res.status(404).json({ error: 'Video no encontrado' });

        const url = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: B2_BUCKET, Key: `videos/${v.id}${v.ext}` }),
            { expiresIn: 3600 }
        );
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, url);
    } catch (err) {
        console.error('Error al reproducir:', err.message);
        res.status(500).json({ error: 'No se pudo cargar el video' });
    }
});

// Página para ver un video con su código: /v/CODIGO
app.get('/v/:codigo', async (req, res) => {
    try {
        const v = await buscarVideo(req.params.codigo.toLowerCase());
        if (!v) return res.status(404).send('Video no encontrado');
        res.type('html').send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(v.titulo)} - Pentu</title>
<link rel="stylesheet" href="/styles.css"></head>
<body><header><a href="/" class="logo-link"><img src="/logo.png" alt="Pentu" class="logo"></a></header>
<main><h2>${escapar(v.titulo)}</h2>
<video src="/api/videos/${v.id}/archivo" controls autoplay style="width:100%;max-height:80vh;background:#000"></video>
<p><small>Código: ${v.id}</small></p></main></body></html>`);
    } catch {
        res.status(500).send('Error al cargar el video');
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pentu funcionando en el puerto ${PORT}, bucket ${B2_BUCKET} (${region})`);
});
