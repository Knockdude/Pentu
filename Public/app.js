const MAX_MB = 2048; // debe coincidir con el límite de server.js

const form = document.getElementById('form-subida');
const archivoInput = document.getElementById('archivo');
const boton = form.querySelector('button');
const barra = document.getElementById('barra');
const estado = document.getElementById('estado');
const lista = document.getElementById('lista-videos');

async function cargarVideos() {
    try {
        const respuesta = await fetch('/api/videos');
        const videos = await respuesta.json();

        lista.replaceChildren();

        if (!Array.isArray(videos) || videos.length === 0) {
            const vacio = document.createElement('p');
            vacio.textContent = 'Todavía no hay videos. ¡Sube el primero!';
            lista.append(vacio);
            return;
        }

        for (const v of videos) {
            const tarjeta = document.createElement('article');
            tarjeta.className = 'video-card';

            const video = document.createElement('video');
            video.src = '/api/videos/' + v.id + '/archivo';
            video.controls = true;
            video.preload = 'metadata';

            const titulo = document.createElement('h3');
            titulo.textContent = v.titulo;

            const fecha = document.createElement('small');
            fecha.textContent = new Date(v.fecha).toLocaleDateString('es');

            const enlace = document.createElement('a');
            enlace.href = '/v/' + v.id;
            enlace.textContent = ' · código ' + v.id;
            enlace.style.color = 'var(--texto-suave)';

            tarjeta.append(video, titulo, fecha, enlace);
            lista.append(tarjeta);
        }
    } catch {
        lista.textContent = 'No se pudieron cargar los videos.';
    }
}

function terminar(mensaje) {
    boton.disabled = false;
    barra.hidden = true;
    estado.textContent = mensaje;
}

async function pedirJSON(url, cuerpo) {
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo || {})
    });
    let datos = {};
    try {
        datos = await r.json();
    } catch {}
    if (!r.ok) throw new Error(datos.error || 'Error al subir el video');
    return datos;
}

// Sube el archivo directo a Firebase Storage con la URL firmada
function enviarArchivo(url, contentType, archivo) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.setRequestHeader('Content-Type', contentType);

        xhr.upload.onprogress = (ev) => {
            if (ev.lengthComputable) {
                barra.hidden = false;
                barra.value = (ev.loaded / ev.total) * 100;
                estado.textContent = `Subiendo... ${Math.round(barra.value)}%`;
            }
        };
        xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300
                ? resolve()
                : reject(new Error('El almacenamiento rechazó el archivo'));
        xhr.onerror = () => reject(new Error('Se perdió la conexión durante la subida'));
        xhr.send(archivo);
    });
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const archivo = archivoInput.files[0];
    if (!archivo) return;
    if (archivo.size > MAX_MB * 1024 * 1024) {
        estado.textContent = `El video supera los ${MAX_MB} MB`;
        return;
    }

    boton.disabled = true;
    estado.textContent = 'Preparando subida...';

    try {
        const titulo = new FormData(form).get('titulo');
        const { id, url, contentType } = await pedirJSON('/api/videos/iniciar', {
            titulo,
            nombre: archivo.name,
            tamano: archivo.size
        });

        await enviarArchivo(url, contentType, archivo);

        estado.textContent = 'Comprobando video...';
        await pedirJSON(`/api/videos/${id}/confirmar`);

        form.reset();
        terminar(`¡Video subido! Su código es ${id}`);
        cargarVideos();
    } catch (err) {
        terminar(err.message);
    }
});

cargarVideos();
