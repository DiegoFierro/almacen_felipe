# Almacén Felipe – Consulta de precios (PWA)

Sitio Hugo de una sola página que lee los precios en vivo desde Google Sheets.

## Usar
    hugo server          # desarrollo (http://localhost:1313)
    hugo                 # genera /public para publicar

Para instalarse como app y funcionar offline hay que servirlo por **HTTPS**
(Netlify, Cloudflare Pages, GitHub Pages, etc.). En `localhost` también anda.

## Planilla
Primera fila (encabezados): `nombre, marca, presentacion, precio, ultima_actualizacion`
(con o sin tildes/mayúsculas). La hoja debe estar compartida como "Cualquiera con el enlace: lector".
El ID de la hoja se cambia arriba de `static/js/app.js`.

## Estructura
- `layouts/`          plantillas (header, search, results)
- `static/css/`       estilos con variables (tema oscuro/claro)
- `static/js/app.js`  lógica
- `static/sw.js`      service worker (offline)
- `static/manifest.webmanifest` + `static/icons/` + `static/favicon.svg`   PWA
