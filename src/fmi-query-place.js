const FMI_PLACE_PROXIES = {
  "Järvenpää": {
    place: "Mäntsälä",
    reason: "FMI sitt direkte stedsoppslag for Järvenpää er tvetydig. Mäntsälä brukes som observasjonsproxy; FMI viser Mäntsälä Hirvihaara som nær observasjonsstasjon for Järvenpää-området.",
  },
  "Vuosaari": {
    place: "Helsinki",
    reason: "FMI sitt direkte Vuosaari-oppslag ga ingen observasjonsrader i trackeren. Helsinki brukes som robust byproxy inntil en stabil stasjons-ID for Vuosaari kan låses.",
  },
  "Raasepori": {
    place: "Hanko",
    reason: "FMI sitt direkte Raasepori/Raseborg-oppslag ga feil eller ingen observasjonsrader. Hanko brukes som regional proxy; FMI viser Hanko Tvärminne som en nær observasjonsstasjon for Raasepori-området.",
  },
};

export function getFmiQueryLocation(target) {
  const proxy = FMI_PLACE_PROXIES[target?.label] || null;
  return {
    place: proxy?.place || target?.location_name,
    proxy: Boolean(proxy),
    proxyReason: proxy?.reason || null,
  };
}
