# Analizador de datos

Subí una planilla (xlsx, xls, ods, csv, tsv, json; varias hojas) y obtené:

1. **Análisis**: estructura, tipos de columna, calidad de datos y hallazgos (correlaciones, tendencias, valores atípicos).
2. **Propuesta**: KPIs, gráficos, tablas y filtros sugeridos con reglas automáticas. Podés marcar y desmarcar lo que quieras.
3. **Dashboard** con filtros cruzados (click en una barra o torta para filtrar).
4. **Reporte** completo o filtrado: imprimir/guardar PDF y descargar Excel.

Es una página estática: no tiene servidor, base de datos ni IA. Los archivos se procesan en el navegador de quien los usa y nunca se suben a ningún lado.

## Archivos

```
index.html, styles.css     interfaz
js/                        lectura, perfilado, propuesta y dashboard
vercel.json                encabezados de seguridad
```

## Publicar gratis (GitHub + Vercel)

1. Subí el contenido de esta carpeta a un repositorio de GitHub.
2. En [vercel.com](https://vercel.com): *Add New → Project* → elegí el repositorio → **Deploy**. No hace falta configurar nada.

Alternativa: GitHub Pages (Settings → Pages → rama `main`, carpeta raíz).

## Límites

- Archivos muy grandes dependen de la memoria del dispositivo (cientos de miles de filas funcionan bien).
- Cada hoja se analiza por separado; no cruza hojas entre sí.
- Los PDF no están soportados.
- Google Sheets: descargá la hoja como Excel o CSV y subí ese archivo.
