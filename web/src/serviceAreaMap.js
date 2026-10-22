// Approximate town centres are only used to frame the map, never as a saved
// pickup point. Add a centre here when enabling another operational area.
// Kafr Kanna: https://www.geonames.org/advanced-search.html?country=IL&q=Kafr+Kann%C4%81
const centres = { "kafr-kanna": { lat: 32.7466, lng: 35.34242 } };
export const serviceAreaCenter = area => Object.hasOwn(centres, area) ? centres[area] : null;
