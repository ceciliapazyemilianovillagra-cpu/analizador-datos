# Analizador de datos

Subí una planilla (xlsx, xls, ods, csv, tsv, json; varias hojas) y obtené:

1. **Análisis**: estructura, tipos de columna, calidad de datos y hallazgos.
2. **Propuesta**: KPIs, gráficos, tablas y filtros sugeridos (reglas automáticas o Gemini).
3. **Dashboard** con filtros cruzados (click en una barra o torta para filtrar).
4. **Reporte** completo o filtrado: imprimir/guardar PDF y descargar Excel.

Los archivos se procesan en el navegador de quien los usa y nunca se suben. A Gemini solo se envían nombres de columnas y estadísticas, nunca filas.

## Archivos

```
index.html, styles.css     interfaz
js/                        lógica (lectura, perfilado, dashboard, IA)
api/ai.js                  función de Vercel que guarda la clave de Gemini
package.json, vercel.json  configuración mínima
```

## Publicar gratis (GitHub + Vercel)

1. Subí el contenido de esta carpeta a un repositorio público de GitHub (sin `.agents/` ni `.claude/`).
2. En Vercel: *Add New → Project* → elegí el repositorio → **Deploy**.
3. La app ya funciona con reglas automáticas. Para activar la IA sin clave, seguí la sección siguiente.

## IA sin clave para los usuarios

La clave de Gemini es tuya y queda en Vercel; nadie la ve.

1. Creá una clave en [Google AI Studio](https://aistudio.google.com/apikey).
2. En Vercel → tu proyecto → *Settings → Environment Variables*, agregá:

   | Nombre | Valor |
   |---|---|
   | `GEMINI_API_KEY` | tu clave (obligatoria) |
   | `GEMINI_MODEL` | opcional, por defecto `gemini-3.8-flash` |
   | `LIMIT_RPM` | usos por minuto de todo el sitio (por defecto 10) |
   | `LIMIT_RPD` | usos por día de todo el sitio (por defecto 100) |
   | `LIMIT_IP_RPM` | usos por minuto por persona (por defecto 3) |
   | `LIMIT_IP_RPD` | usos por día por persona (por defecto 10) |

   Poné en `LIMIT_RPM` y `LIMIT_RPD` los límites que te muestra tu consola de AI Studio, o menos.
3. Contador compartido: en Vercel → *Storage* (o *Marketplace*) → **Upstash Redis** (plan gratis) → conectalo al proyecto. Vercel agrega solo las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN`.
4. *Deployments → Redeploy* para que tome las variables.

Sin Redis, el contador vive en la memoria de la función y no es confiable: los números se reinician y no se comparten entre instancias.

Si el cupo compartido se agota, la página lo avisa con cuenta regresiva, sigue funcionando con las reglas automáticas, y cada persona puede pegar su propia clave en «Usar mi propia clave».

## Límites

- Archivos muy grandes dependen de la memoria del dispositivo (cientos de miles de filas funcionan bien).
- Cada hoja se analiza por separado; no cruza hojas entre sí.
- Los PDF no están soportados.
- En el plan gratuito, Google puede usar lo que recibe para mejorar sus productos.
