// Demo data, used only with ?demo in the address. Device names are Joakim's; values are examples.
window.HOME_DEMO_DATA = function (state, day) {
  var spot = [1.309, 1.3157, 1.3119, 1.3079, 1.361, 1.3194, 1.3325, 1.33, 1.3252, 1.3177, 1.3128, 1.3094, 1.3076, 1.3039, 1.313, 1.3199, 1.2874, 1.2855, 1.2956, 1.3218, 1.2892, 1.3286, 1.3905, 1.4493, 1.2964, 1.5192, 1.6921, 1.7492, 1.7643, 1.8274, 1.8551, 1.8961, 1.9028, 1.8904, 1.8551, 1.8142, 1.8918, 1.8817, 1.8356, 1.7815, 1.8504, 1.7644, 1.7089, 1.6513, 1.6684, 1.6197, 1.5921, 1.5684, 1.5639, 1.5333, 1.5264, 1.5313, 1.5546, 1.5737, 1.595, 1.575, 1.6138, 1.6335, 1.7024, 1.7553, 1.6645, 1.7676, 1.8825, 1.9344, 1.8297, 1.8656, 1.8724, 1.9037, 1.8694, 1.8746, 1.8677, 1.8687, 1.8492, 1.8601, 1.8568, 1.8512, 1.8473, 1.8074, 1.8069, 1.7872, 1.7939, 1.7483, 1.7004, 1.6319, 1.6518, 1.6008, 1.5172, 1.4556, 1.5686, 1.5016, 1.4943, 1.4575, 1.4932, 1.4428, 1.4003, 1.3652];
  var T = window.APP_CONFIG.tariffs;
  state.zones = {"z1": {"id": "z1", "name": "Køkken"}, "z2": {"id": "z2", "name": "Bryggers"}, "z3": {"id": "z3", "name": "Badeværelse"}, "z4": {"id": "z4", "name": "Stue"}, "z5": {"id": "z5", "name": "1. sal"}, "z6": {"id": "z6", "name": "Loft"}, "z7": {"id": "z7", "name": "Udenfor"}, "z8": {"id": "z8", "name": "Teknikrum"}};
  state.devices = {"d0": {"id": "d0", "name": "Spots Bryggers", "class": "light", "zone": "z2", "available": true, "capabilitiesObj": {"onoff": {"value": true}, "dim": {"value": 0.8}}}, "d1": {"id": "d1", "name": "Spots Badeværelse Stue", "class": "light", "zone": "z3", "available": true, "capabilitiesObj": {"onoff": {"value": false}, "dim": {"value": 0.5}}}, "d2": {"id": "d2", "name": "Fugt/Temp Køkken", "class": "sensor", "zone": "z1", "available": true, "capabilitiesObj": {"measure_temperature": {"value": 21.4}, "measure_humidity": {"value": 46}, "measure_battery": {"value": 92}}}, "d3": {"id": "d3", "name": "Fugt/Temp 1.Sal", "class": "sensor", "zone": "z5", "available": true, "capabilitiesObj": {"measure_temperature": {"value": 19.8}, "measure_humidity": {"value": 52}, "measure_battery": {"value": 88}}}, "d4": {"id": "d4", "name": "Dørsensor", "class": "sensor", "zone": "z2", "available": true, "capabilitiesObj": {"alarm_contact": {"value": false}, "measure_battery": {"value": 75}}}, "d5": {"id": "d5", "name": "Vinduesensor", "class": "sensor", "zone": "z4", "available": true, "capabilitiesObj": {"alarm_contact": {"value": false}, "measure_battery": {"value": 81}}}, "d6": {"id": "d6", "name": "Loft PIR", "class": "sensor", "zone": "z6", "available": true, "capabilitiesObj": {"alarm_motion": {"value": false}, "measure_battery": {"value": 64}}}, "d7": {"id": "d7", "name": "Tryk Bryggers", "class": "button", "zone": "z2", "available": true, "capabilitiesObj": {}}, "d8": {"id": "d8", "name": "Tryk Badeværelse Stue", "class": "button", "zone": "z3", "available": true, "capabilitiesObj": {}}, "d9": {"id": "d9", "name": "Sonos Badeværelse", "class": "speaker", "zone": "z3", "available": true, "capabilitiesObj": {"onoff": {"value": false}}}, "d10": {"id": "d10", "name": "Solafskærmning", "class": "windowcoverings", "zone": "z7", "available": true, "capabilitiesObj": {"windowcoverings_set": {"value": 1}}}, "d11": {"id": "d11", "name": "PowerTag hovedforsyning (example)", "class": "sensor", "zone": "z8", "available": true, "capabilitiesObj": {"measure_power": {"value": 2380}}}};
  state.prices = spot.map(function (s, i) {
    var h = Math.floor(i / 4), m = (i % 4) * 15;
    var g = (T.grid.find(function (x) { return h >= x.from && h < x.to; }) || { kr: 0 }).kr;
    var other = T.energinet + T.supplierMarkup + T.elafgift;
    var vat = (s + g + other) * T.vat;
    return { t: day + 'T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'), spot: s, grid: g, other: other, vat: vat, total: s + g + other + vat };
  });
  // tomorrow: the same curve a little cheaper, so the rolling 24 hours can be seen in the demo
  var d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  var tomorrow = d.toISOString().slice(0, 10);
  state.prices = state.prices.concat(state.prices.map(function (p) {
    var s2 = p.spot * 0.85, vat = (s2 + p.grid + p.other) * T.vat;
    return { t: tomorrow + p.t.slice(10), spot: s2, grid: p.grid, other: p.other, vat: vat, total: s2 + p.grid + p.other + vat };
  }));
  state.pricesDay = day;
  state.homey = { name: "Joakim's Homey Pro (demo)" };
  // 24 hours of example history for the "How the house holds heat" tile
  var now = Date.now(), H = 3600000;
  var g = [21.9,21.9,21.8,21.8,21.7,21.7,21.6,21.6,21.5,21.5,21.5,21.6,21.7,21.8,21.8,21.7,21.7,21.6,21.6,21.5,21.5,21.4,21.4,21.4,21.4];
  var f = [20.9,20.8,20.7,20.6,20.5,20.4,20.3,20.2,20.1,20.0,20.0,20.1,20.2,20.3,20.3,20.2,20.1,20.0,20.0,19.9,19.9,19.8,19.8,19.8,19.8];
  var o = [5.8,5.3,4.7,4.0,3.2,2.4,1.6,0.8,0.1,-0.5,-0.9,-0.6,0.3,1.4,2.4,3.0,3.2,2.8,2.1,1.4,0.8,0.3,0.0,-0.2,-0.4];
  var mk = function (arr) { return arr.map(function (v, i) { return { t: now - (24 - i) * H, v: v }; }); };
  state.heat.hist = { ground: mk(g), first: mk(f) };
  state.heat.outside = { now: -0.4, series: mk(o) };
  state.heat.source = 'insights';
  // example of yesterday's consumption from Eloverblik
  state.yesterday = { day: 'yesterday', back: 1, kwh: 41.2, cost: 128.4, avg: 3.12, priced: true };
};
