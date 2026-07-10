// Agente de impresión local — Boca'o
// Corre en el computador donde está instalada (por USB) la impresora térmica,
// con su driver ya instalado en Windows. Revisa Firebase cada 3 segundos por
// trabajos de impresión pendientes (comandas y facturas encoladas desde
// pos.html / cocina.html) y los manda directo a la impresora por su nombre
// de Windows (protocolo ESC/POS crudo, vía "copy /b" al recurso compartido).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const FIREBASE_PROJECT_ID = 'e703-18361';
const FIREBASE_API_KEY = 'AIzaSyB7fkzZNNNY5oWt5oSAT-2wSwtJh69TKvs';

const CONFIG_PATH = path.join(__dirname, 'config.json');
var config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('No se pudo leer config.json. Debe estar en la misma carpeta que agent.js');
  process.exit(1);
}
if (!config.WINDOWS_PRINTER_NAME) {
  console.error('⚠️  Abre config.json y pon el nombre de la impresora en "WINDOWS_PRINTER_NAME" (ej: "XP-58").');
  process.exit(1);
}

// ── Utilidades de texto ──
var MAPA_ACENTOS = {'á':'a','é':'e','í':'i','ó':'o','ú':'u','Á':'A','É':'E','Í':'I','Ó':'O','Ú':'U','ñ':'n','Ñ':'N','ü':'u','Ü':'U'};
function quitarAcentos(s) {
  return (s || '').toString().replace(/[áéíóúÁÉÍÓÚñÑüÜ]/g, function (c) { return MAPA_ACENTOS[c] || c; });
}
function fmtMoney(n) { return '$' + Math.round(n || 0).toLocaleString('es-CO'); }
function linea(ancho, ch) { return (ch || '-').repeat(ancho) + '\n'; }
function dosColumnas(izq, der, ancho) {
  if (!der) return izq;
  var espacio = ancho - izq.length - der.length;
  if (espacio < 1) espacio = 1;
  return izq + ' '.repeat(espacio) + der;
}

// ── Comandos ESC/POS ──
var ESC = '\x1B', GS = '\x1D';
function init() { return ESC + '@'; }
function centrar() { return ESC + 'a' + '\x01'; }
function izquierda() { return ESC + 'a' + '\x00'; }
function negritaOn() { return ESC + 'E' + '\x01'; }
function negritaOff() { return ESC + 'E' + '\x00'; }
function grande() { return GS + '!' + '\x11'; }
function normalTam() { return GS + '!' + '\x00'; }
function corte() { return '\n\n\n' + GS + 'V' + '\x01'; }

// ── Construcción del ticket ──
function buildTicket(job) {
  var ANCHO = config.ANCHO || 32; // XP-58 = 58mm, ~32 caracteres por línea
  var out = init();
  out += centrar() + negritaOn() + grande();
  out += quitarAcentos("BOCA'O FAST FOOD") + '\n';
  out += normalTam() + negritaOff();

  var tipoLabel = job.tipo === 'factura' ? 'FACTURA' : 'COMANDA';
  var tipoPedidoLabel = job.tipoPedido === 'domicilio' ? 'DOMICILIO' : 'RECOGER';
  out += negritaOn() + tipoLabel + ' #' + job.numero + ' - ' + tipoPedidoLabel + negritaOff() + '\n';
  out += izquierda();
  out += linea(ANCHO);

  var fecha = job.fecha ? new Date(job.fecha).toLocaleString('es-CO') : new Date().toLocaleString('es-CO');
  out += quitarAcentos('Fecha: ' + fecha) + '\n';
  out += quitarAcentos('Cajero: ' + (job.cajero || '')) + '\n';

  var cli = job.cliente || {};
  if (cli.nombre) out += negritaOn() + quitarAcentos('Cliente: ' + cli.nombre) + negritaOff() + '\n';
  if (cli.telefono) out += quitarAcentos('Tel: ' + cli.telefono) + '\n';
  if (job.tipoPedido === 'domicilio' && cli.direccion) out += quitarAcentos('Dir: ' + cli.direccion) + '\n';
  if (job.tipoPedido === 'domicilio' && cli.barrio) out += quitarAcentos('Barrio: ' + cli.barrio) + '\n';
  out += linea(ANCHO);

  (job.items || []).forEach(function (i) {
    var nombre = quitarAcentos(i.cantidad + 'x ' + i.nombre + (i.variante && i.variante !== 'Precio' ? ' (' + i.variante + ')' : ''));
    var precio = job.tipo === 'factura' ? fmtMoney(i.precio * i.cantidad) : '';
    out += dosColumnas(nombre, precio, ANCHO) + '\n';
    if (i.notas) out += '  > ' + quitarAcentos(i.notas) + '\n';
  });
  out += linea(ANCHO);

  if (job.tipo === 'factura') {
    out += dosColumnas('Subtotal', fmtMoney(job.subtotal), ANCHO) + '\n';
    if (job.costoEnvio > 0) out += dosColumnas('Domicilio', fmtMoney(job.costoEnvio), ANCHO) + '\n';
    out += negritaOn() + dosColumnas('TOTAL', fmtMoney(job.total), ANCHO) + negritaOff() + '\n';
    if (job.metodoPago) {
      var m = { efectivo: 'Efectivo', nequi: 'Nequi', transferencia: 'Transferencia' };
      out += quitarAcentos('Pago: ' + (m[job.metodoPago] || job.metodoPago)) + '\n';
    }
  }
  if (job.notasGenerales) out += quitarAcentos('Notas: ' + job.notasGenerales) + '\n';
  out += linea(ANCHO);
  out += centrar() + (job.tipo === 'factura' ? quitarAcentos('¡Gracias por tu pedido!') : '-- Fin de comanda --') + '\n';
  out += corte();
  return out;
}

// ── Firestore REST (sin dependencias externas) ──
function parseFirestoreValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return parseFirestoreFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(parseFirestoreValue);
  return null;
}
function parseFirestoreFields(fields) {
  var obj = {};
  Object.keys(fields || {}).forEach(function (k) { obj[k] = parseFirestoreValue(fields[k]); });
  return obj;
}

async function obtenerTrabajosPendientes() {
  var url = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/trabajos_impresion?key=' + FIREBASE_API_KEY + '&pageSize=100';
  var res = await fetch(url);
  var data = await res.json();
  var jobs = [];
  (data.documents || []).forEach(function (doc) {
    var f = parseFirestoreFields(doc.fields);
    if (f.estado === 'pendiente') {
      var id = doc.name.split('/').pop();
      jobs.push(Object.assign({ _id: id }, f));
    }
  });
  return jobs;
}

async function marcarImpreso(id) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/trabajos_impresion/' + id + '?updateMask.fieldPaths=estado&key=' + FIREBASE_API_KEY;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { estado: { stringValue: 'impreso' } } })
  });
}

// ── Envío a la impresora (nombre de Windows, compartida localmente) ──
function enviarAImpresora(bytes) {
  return new Promise(function (resolve, reject) {
    var tmpFile = path.join(os.tmpdir(), 'bocao_ticket_' + Date.now() + '.bin');
    fs.writeFile(tmpFile, bytes, function (err) {
      if (err) return reject(err);
      var destino = '\\\\localhost\\' + config.WINDOWS_PRINTER_NAME;
      var cmd = 'cmd /c copy /b "' + tmpFile + '" "' + destino + '"';
      exec(cmd, function (err2) {
        fs.unlink(tmpFile, function () {});
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

// ── Loop principal ──
async function revisarCola() {
  try {
    var jobs = await obtenerTrabajosPendientes();
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      console.log('Imprimiendo', job.tipo, '#' + job.numero + '...');
      try {
        var texto = buildTicket(job);
        var bytes = Buffer.from(texto, 'latin1');
        await enviarAImpresora(bytes);
        await marcarImpreso(job._id);
        console.log('  -> impreso OK');
      } catch (e) {
        console.error('  -> ERROR imprimiendo #' + job.numero + ':', e.message);
      }
    }
  } catch (e) {
    console.error('Error revisando la cola de impresión:', e.message);
  }
}

console.log("Agente de impresión Boca'o iniciado.");
console.log('Impresora configurada: "' + config.WINDOWS_PRINTER_NAME + '" (compartida como \\\\localhost\\' + config.WINDOWS_PRINTER_NAME + ')');
console.log('Revisando trabajos pendientes cada 3 segundos... (deja esta ventana abierta)');
setInterval(revisarCola, 3000);
revisarCola();
