/* =========================
   REAL VEHICLE LOOKUP ONLY
   ========================= */

const recCache = new Map();

function cleanPlate(plate) {
  return String(plate || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function fetchDvlaRecord(plate) {

  if (!settings.dvlaApiKey)
    throw new Error('DVLA API key missing');

  const response = await fetch(
    settings.dvlaProxyUrl ||
    'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.dvlaApiKey
      },
      body: JSON.stringify({
        registrationNumber: cleanPlate(plate)
      })
    }
  );

  if (!response.ok)
    throw new Error(`DVLA Error ${response.status}`);

  const data = await response.json();

  return {
    registrationNumber: data.registrationNumber,
    make: data.make || 'UNKNOWN',
    colour: data.colour || 'UNKNOWN',
    yearOfManufacture: data.yearOfManufacture || '',
    fuelType: data.fuelType || 'UNKNOWN',
    engineCapacity: data.engineCapacity || '',
    co2Emissions: data.co2Emissions || '',
    taxStatus: data.taxStatus || 'UNKNOWN',
    taxDueDate: data.taxDueDate || '',
    motStatus: data.motStatus || 'UNKNOWN',
    motExpiryDate: data.motExpiryDate || '',
    isRealDvlaData: true
  };
}

async function getRecord(plate) {

  const reg = cleanPlate(plate);

  if (recCache.has(reg))
    return recCache.get(reg);

  try {

    const record = await fetchDvlaRecord(reg);

    recCache.set(reg, record);

    return record;

  } catch (err) {

    console.error(err);

    return {
      registrationNumber: reg,
      make: 'UNKNOWN',
      colour: 'UNKNOWN',
      fuelType: 'UNKNOWN',
      taxStatus: 'UNKNOWN',
      motStatus: 'UNKNOWN',
      isRealDvlaData: false,
      error: 'Vehicle record unavailable'
    };
  }
}

async function evaluate(plate) {

  const record = await getRecord(plate);

  const flags = [];

  const hot = HOT.find(
    x => cleanPlate(x.plate) === cleanPlate(plate)
  );

  if (hot) {
    flags.push({
      t: 'Watchlist Match',
      sev: 'alert'
    });
  }

  if (
    record.taxStatus &&
    record.taxStatus.toLowerCase() === 'untaxed'
  ) {
    flags.push({
      t: 'Untaxed',
      sev: 'warn'
    });
  }

  if (
    record.motStatus &&
    record.motStatus.toLowerCase() !== 'valid'
  ) {
    flags.push({
      t: 'MOT Warning',
      sev: 'warn'
    });
  }

  const severity =
    flags.some(f => f.sev === 'alert')
      ? 'alert'
      : flags.length
      ? 'warn'
      : 'ok';

  return {
    rec: record,
    flags,
    sev: severity
  };
}
