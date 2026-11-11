"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeslaPlatform = void 0;
const TeslaAPI_1 = require("./TeslaAPI");

class TeslaPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.vehicleId = null;
    this.vehicleData = null;
    this.pollInterval = (config.pollInterval || 300) * 1000;
    this.offlineRetryDelay = 5 * 60 * 1000;
    this.offlineRetryTimer = null;
    this.pollInProgress = false;
    this.pollingStarted = false;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.homeLatitude = parseFloat(config.home_lat || 0);
    this.homeLongitude = parseFloat(config.home_long || 0);
    this.homeRadiusMeters = parseInt(config.home_radius || 200);
    this.homeEnabled = !!(this.homeLatitude && this.homeLongitude);
    this.batteryTile = String(config.battery_tile || "false").toLowerCase() === "true";
    this.chargeCurrentControl = String(config.charge_current_control || "thermostat").toLowerCase();

    this.tesla = new TeslaAPI_1.TeslaApi({
      accessToken: config.accessToken || "",
      refreshToken: config.refreshToken || "",
      clientId: config.clientId || "",
      clientSecret: config.clientSecret || "",
      region: config.region || "EU",
      vin: config.vin || "",
      proxyUrl: config.proxyUrl || "",
      log: (msg) => this.log(msg)
    });

    api.on("didFinishLaunching", () => {
      this.log("Tesla plugin v1.8.2 launched - Fleet API (partner registered)");
      this.discoverVehicle();
    });
  }

  async discoverVehicle() {
    try {
      this.log("Discovering Tesla vehicle...");
      const vehicle = await this.tesla.getVehicle();
      if (!vehicle) {
        this.retryCount++;
        if (this.retryCount <= this.maxRetries) {
          const delay = Math.min(30000 * this.retryCount, 300000);
          this.log("No vehicle found. Retry " + this.retryCount + "/" + this.maxRetries + " in " + (delay/1000) + "s");
          setTimeout(() => this.discoverVehicle(), delay);
        } else {
          this.log("No vehicle found after " + this.maxRetries + " retries. Check config and tokens.");
        }
        return;
      }
      this.retryCount = 0;
      this.vehicleId = vehicle.id_s || String(vehicle.id);
      this.log("Found vehicle: " + (vehicle.display_name || vehicle.vin) + " (ID: " + this.vehicleId + ", VIN: " + (vehicle.vin || "?") + ", State: " + (vehicle.state || "?") + ")");

      const uuid = this.api.hap.uuid.generate("tesla-vehicle-v2-" + this.vehicleId);
      let existingAcc = this.accessories.find(a => a.UUID === uuid);
      if (!existingAcc) {
        const acc = new this.api.platformAccessory(vehicle.display_name || "Tesla", uuid);
        this.configureAccessory(acc);
        this.setupServices(acc);
        this.api.registerPlatformAccessories("homebridge-tesla-vehicle-control", "TeslaControl", [acc]);
        this.log("Registered new accessory: " + (vehicle.display_name || "Tesla"));
      } else {
        this.setupServices(existingAcc);
        this.log("Restored cached accessory: " + (vehicle.display_name || "Tesla"));
      }
      this.startPolling();
    } catch (e) {
      this.retryCount++;
      if (this.retryCount <= this.maxRetries) {
        const delay = Math.min(30000 * this.retryCount, 300000);
        this.log("Discovery error: " + e.message + ". Retry in " + (delay/1000) + "s");
        setTimeout(() => this.discoverVehicle(), delay);
      }
    }
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  setupServices(accessory) {
    const S = this.Service;
    const C = this.Characteristic;
    const carName = accessory.displayName || "Tesla";
    const n = (label) => `${carName} - ${label}`;

    // Lock
    let lockService = accessory.getService(S.LockMechanism) || accessory.addService(S.LockMechanism, n("Lock"), "lock");
    lockService.setCharacteristic(C.Name, n("Lock"));
    lockService.getCharacteristic(C.LockTargetState).onSet(async (value) => {
      try {
        await this._ensureAwake();
        const locked = value === C.LockTargetState.SECURED;
        if (locked) { await this.tesla.lock(this.vehicleId); }
        else { await this.tesla.unlock(this.vehicleId); }

        this._updateLockState(lockService, locked);
        this.log(locked ? "Locked - HomeKit state updated" : "Unlocked - HomeKit state updated");
      } catch (e) { this.log("Lock error: " + e.message); }
    });


    // Climate (Thermostat)
    let thermoService = accessory.getService(S.Thermostat) || accessory.addService(S.Thermostat, n("Climate"), "climate");
    thermoService.setCharacteristic(C.Name, n("Climate"));
    thermoService.getCharacteristic(C.CurrentTemperature).onGet(() => {
      if (this.vehicleData && this.vehicleData.climate_state) {
        return this.vehicleData.climate_state.inside_temp || 20;
      }
      return 20;
    });
    thermoService.getCharacteristic(C.CurrentHeatingCoolingState).onGet(() => {
      if (this.vehicleData && this.vehicleData.climate_state) {
        return this.vehicleData.climate_state.is_climate_on ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF;
      }
      return C.CurrentHeatingCoolingState.OFF;
    });
    thermoService.getCharacteristic(C.TargetHeatingCoolingState).onGet(() => {
      if (this.vehicleData && this.vehicleData.climate_state) {
        return this.vehicleData.climate_state.is_climate_on ? C.TargetHeatingCoolingState.HEAT : C.TargetHeatingCoolingState.OFF;
      }
      return C.TargetHeatingCoolingState.OFF;
    });
    thermoService.getCharacteristic(C.TargetHeatingCoolingState).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value === C.TargetHeatingCoolingState.OFF) { await this.tesla.climateOff(this.vehicleId); this.log("Climate OFF"); }
        else { await this.tesla.climateOn(this.vehicleId); this.log("Climate ON"); }
      } catch (e) { this.log("Climate error: " + e.message); }
    });
    thermoService.getCharacteristic(C.TargetTemperature).onGet(() => {
      if (this.vehicleData && this.vehicleData.climate_state) {
        return this.vehicleData.climate_state.driver_temp_setting || 20;
      }
      return 20;
    });
    thermoService.getCharacteristic(C.TargetTemperature).onSet(async (value) => {
      try {
        await this._ensureAwake();
        await this.tesla.setTemp(this.vehicleId, value, value);
        this.log("Temperature set to " + value + "C");
      } catch (e) { this.log("Temperature error: " + e.message); }
    });
    thermoService.getCharacteristic(C.TemperatureDisplayUnits).onGet(() => C.TemperatureDisplayUnits.CELSIUS);
    thermoService.getCharacteristic(C.TargetTemperature).setProps({ minValue: 10, maxValue: 28, minStep: 0.5 });
    thermoService.updateCharacteristic(C.TargetTemperature, 20);
    thermoService.updateCharacteristic(C.CurrentTemperature, 20);

    // Sentry Mode
    let sentryService = accessory.getServiceById(S.Switch, "sentry") || accessory.addService(S.Switch, n("Sentry"), "sentry");
    sentryService.setCharacteristic(C.Name, n("Sentry"));
    sentryService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) {
          await this.tesla.sentryOn(this.vehicleId);
          this.log("Sentry ON");

        } else {
          await this.tesla.sentryOff(this.vehicleId);
          this.log("Sentry OFF");
        }
      } catch (e) { this.log("Sentry error: " + e.message); }
    });

    // Trunk (momentary)
    let trunkService = accessory.getServiceById(S.Switch, "trunk") || accessory.addService(S.Switch, n("Trunk"), "trunk");
    trunkService.setCharacteristic(C.Name, n("Trunk"));
    trunkService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        if (value) { await this._ensureAwake(); await this.tesla.openTrunk(this.vehicleId); this.log("Trunk opened"); }
        setTimeout(() => trunkService.updateCharacteristic(C.On, false), 3000);
      } catch (e) { this.log("Trunk error: " + e.message); }
    });

    // Frunk (momentary)
    let frunkService = accessory.getServiceById(S.Switch, "frunk") || accessory.addService(S.Switch, n("Frunk"), "frunk");
    frunkService.setCharacteristic(C.Name, n("Frunk"));
    frunkService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        if (value) { await this._ensureAwake(); await this.tesla.openFrunk(this.vehicleId); this.log("Frunk opened"); }
        setTimeout(() => frunkService.updateCharacteristic(C.On, false), 3000);
      } catch (e) { this.log("Frunk error: " + e.message); }
    });

    // Charge Port
    let chargePortService = accessory.getServiceById(S.Switch, "chargeport") || accessory.addService(S.Switch, n("Charge Port"), "chargeport");
    chargePortService.setCharacteristic(C.Name, n("Charge Port"));
    chargePortService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) { await this.tesla.openChargePort(this.vehicleId); this.log("Charge port opened"); }
        else { await this.tesla.closeChargePort(this.vehicleId); this.log("Charge port closed"); }
      } catch (e) { this.log("Charge port error: " + e.message); }
    });

    // Charging
    let chargingService = accessory.getServiceById(S.Switch, "charging") || accessory.addService(S.Switch, n("Charging"), "charging");
    chargingService.setCharacteristic(C.Name, n("Charging"));
    chargingService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) { await this.tesla.startCharging(this.vehicleId); this.log("Charging started"); }
        else { await this.tesla.stopCharging(this.vehicleId); this.log("Charging stopped"); }
      } catch (e) { this.log("Charging error: " + e.message); }
    });

    // Flash Lights (momentary)
    let flashService = accessory.getServiceById(S.Switch, "flash") || accessory.addService(S.Switch, n("Flash Lights"), "flash");
    flashService.setCharacteristic(C.Name, n("Flash Lights"));
    flashService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        if (value) { await this._ensureAwake(); await this.tesla.flashLights(this.vehicleId); this.log("Lights flashed"); }
        setTimeout(() => flashService.updateCharacteristic(C.On, false), 2000);
      } catch (e) { this.log("Flash error: " + e.message); }
    });

    // Horn (momentary)
    let hornService = accessory.getServiceById(S.Switch, "horn") || accessory.addService(S.Switch, n("Horn"), "horn");
    hornService.setCharacteristic(C.Name, n("Horn"));
    hornService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        if (value) { await this._ensureAwake(); await this.tesla.honkHorn(this.vehicleId); this.log("Horn honked"); }
        setTimeout(() => hornService.updateCharacteristic(C.On, false), 2000);
      } catch (e) { this.log("Horn error: " + e.message); }
    });

    // Remove obsolete Dashcam cached service (not supported by Tesla Fleet API)
    const oldDashcamService = accessory.getServiceById(S.Switch, "dashcam");
    if (oldDashcamService) {
      accessory.removeService(oldDashcamService);
      this.log("Removed obsolete Dashcam service (not supported by Tesla Fleet API)");
    }

    // Vent Windows (toggle)
    let ventService = accessory.getServiceById(S.Switch, "vent") || accessory.addService(S.Switch, n("Windows"), "vent");
    ventService.setCharacteristic(C.Name, n("Windows"));
    ventService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) { await this.tesla.ventWindows(this.vehicleId); this.log("Windows vented"); }
        else { await this.tesla.closeWindows(this.vehicleId); this.log("Windows closed"); }
      } catch (e) { this.log("Windows error: " + e.message); }
    });

    // Defrost (toggle)
    let defrostService = accessory.getServiceById(S.Switch, "defrost") || accessory.addService(S.Switch, n("Defrost"), "defrost");
    defrostService.setCharacteristic(C.Name, n("Defrost"));
    defrostService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        if (value) { await this.tesla.defrostOn(this.vehicleId); this.log("Defrost ON"); }
        else { await this.tesla.defrostOff(this.vehicleId); this.log("Defrost OFF"); }
      } catch (e) { this.log("Defrost error: " + e.message); }
    });

    // Steering Wheel Heater (toggle)
    let steeringService = accessory.getServiceById(S.Switch, "steeringheater") || accessory.addService(S.Switch,  n("Steering Wheel Heater"), "steeringheater");
    steeringService.setCharacteristic(C.Name, n("Steering Wheel Heater"));
    steeringService.getCharacteristic(C.On).onSet(async (value) => {
      try {
        await this._ensureAwake();
        await this.tesla.steeringWheelHeater(this.vehicleId, value);
        this.log("Steering wheel heater " + (value ? "ON" : "OFF"));
      } catch (e) { this.log("Steering heater error: " + e.message); }
    });

    // Charge Limit (Lightbulb brightness = 50-100%)
    let chargeLimitService = accessory.getServiceById(S.Lightbulb, "chargelimit") || accessory.addService(S.Lightbulb, n("Charge Limit"), "chargelimit");
    chargeLimitService.setCharacteristic(C.Name, n("Charge Limit"));
    chargeLimitService.getCharacteristic(C.On).onGet(() => true);
    chargeLimitService.getCharacteristic(C.On).onSet(async () => {});
    chargeLimitService.getCharacteristic(C.Brightness).onGet(() => {
      if (this.vehicleData && this.vehicleData.charge_state) {
        return this.vehicleData.charge_state.charge_limit_soc || 80;
      }
      return 80;
    });
    chargeLimitService.getCharacteristic(C.Brightness).onSet(async (value) => {
      try {
        await this._ensureAwake();
        const limit = Math.max(50, Math.min(100, value));
        await this.tesla.setChargeLimit(this.vehicleId, limit);
        this.log("Charge limit set to " + limit + "%");
      } catch (e) { this.log("Charge limit error: " + e.message); }
    });
    chargeLimitService.getCharacteristic(C.Brightness).setProps({ minValue: 50, maxValue: 100, minStep: 5 });
    chargeLimitService.updateCharacteristic(C.Brightness, 80);

    // Charge Current
    const oldChargeAmpsThermo = accessory.getServiceById(S.Thermostat, "chargeamps_thermo");
    const oldChargeAmpsHeaterCooler = accessory.getServiceById(S.HeaterCooler, "chargeamps_heatercooler");
    const oldChargeAmpsLight = accessory.getServiceById(S.Lightbulb, "chargeamps");

    if (this.chargeCurrentControl === "lightbulb") {
      if (oldChargeAmpsThermo) accessory.removeService(oldChargeAmpsThermo);
      if (oldChargeAmpsHeaterCooler) accessory.removeService(oldChargeAmpsHeaterCooler);

      let chargeAmpsService =
        oldChargeAmpsLight ||
        accessory.addService(S.Lightbulb, n("Charge Current"), "chargeamps");

      chargeAmpsService.setCharacteristic(C.Name, n("Charge Current"));

      chargeAmpsService.getCharacteristic(C.On).onGet(() => true);
      chargeAmpsService.getCharacteristic(C.On).onSet(async () => {});

      chargeAmpsService.getCharacteristic(C.Brightness).onGet(() => {
        const amps = this.vehicleData?.charge_state?.charge_current_request || 16;
        return this._ampsToBrightness(amps);
      });

      chargeAmpsService.getCharacteristic(C.Brightness).onSet(async (value) => {
        try {
          await this._ensureAwake();
          const amps = this._brightnessToAmps(value);
          await this.tesla.setChargeAmps(this.vehicleId, amps);
          // Keep local cache in sync until next poll
          if (this.vehicleData?.charge_state) {
            this.vehicleData.charge_state.charge_current_request = amps;
            this.vehicleData.charge_state.charge_amps = amps;
          }
          chargeAmpsService.updateCharacteristic(C.Brightness, this._ampsToBrightness(amps));
          this.log("Charge amps set to " + amps + "A");
        } catch (e) {
          this.log("Charge amps error: " + e.message);
        }
      });

      chargeAmpsService.getCharacteristic(C.Brightness).setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1
      });

      chargeAmpsService.updateCharacteristic(C.Brightness, this._ampsToBrightness(16));
    } else {
      if (oldChargeAmpsLight) accessory.removeService(oldChargeAmpsLight);
      if (oldChargeAmpsThermo) accessory.removeService(oldChargeAmpsThermo);

      let chargeAmpsHeaterCooler =
        oldChargeAmpsHeaterCooler ||
        accessory.addService(S.HeaterCooler, n("Charge Current"), "chargeamps_heatercooler");

      chargeAmpsHeaterCooler.setCharacteristic(C.Name, n("Charge Current"));

      chargeAmpsHeaterCooler.getCharacteristic(C.Active).onGet(() => {
        return C.Active.ACTIVE;
      });

      chargeAmpsHeaterCooler.getCharacteristic(C.Active).onSet(async () => {});

      chargeAmpsHeaterCooler.getCharacteristic(C.CurrentHeaterCoolerState).onGet(() => {
        return C.CurrentHeaterCoolerState.HEATING;
      });

      chargeAmpsHeaterCooler.getCharacteristic(C.TargetHeaterCoolerState).setProps({
        validValues: [C.TargetHeaterCoolerState.HEAT]
      });

      chargeAmpsHeaterCooler.getCharacteristic(C.TargetHeaterCoolerState).onGet(() => {
        return C.TargetHeaterCoolerState.HEAT;
      });

      chargeAmpsHeaterCooler.getCharacteristic(C.TargetHeaterCoolerState).onSet(async () => {});

      chargeAmpsHeaterCooler.getCharacteristic(C.CurrentTemperature).setProps({
        minValue: 5,
        maxValue: 32,
        minStep: 1
      });

      chargeAmpsHeaterCooler.getCharacteristic(C.CurrentTemperature).onGet(() => {
        return this.vehicleData?.charge_state?.charge_current_request || 16;
      });

      chargeAmpsHeaterCooler.getCharacteristic(C.HeatingThresholdTemperature).setProps({
        minValue: 5,
        maxValue: 32,
        minStep: 1
      });

      chargeAmpsHeaterCooler.getCharacteristic(C.HeatingThresholdTemperature).onGet(() => {
        return this.vehicleData?.charge_state?.charge_current_request || 16;
      });

      chargeAmpsHeaterCooler.getCharacteristic(C.HeatingThresholdTemperature).onSet(async (value) => {
        try {
          await this._ensureAwake();
          const amps = Math.max(5, Math.min(32, Math.round(value)));
          await this.tesla.setChargeAmps(this.vehicleId, amps);
          // Keep local cache in sync until next poll
          if (this.vehicleData?.charge_state) {
            this.vehicleData.charge_state.charge_current_request = amps;
            this.vehicleData.charge_state.charge_amps = amps;
          }
          chargeAmpsHeaterCooler.updateCharacteristic(C.CurrentTemperature, amps);
          chargeAmpsHeaterCooler.updateCharacteristic(C.HeatingThresholdTemperature, amps);
          this.log("Charge amps set to " + amps + "A");
        } catch (e) {
          this.log("Charge amps error: " + e.message);
        }
      });

      chargeAmpsHeaterCooler.getCharacteristic(C.TemperatureDisplayUnits).onGet(() => {
        return C.TemperatureDisplayUnits.CELSIUS;
      });

      chargeAmpsHeaterCooler.updateCharacteristic(C.Active, C.Active.ACTIVE);
      chargeAmpsHeaterCooler.updateCharacteristic(C.CurrentHeaterCoolerState, C.CurrentHeaterCoolerState.HEATING);
      chargeAmpsHeaterCooler.updateCharacteristic(C.TargetHeaterCoolerState, C.TargetHeaterCoolerState.HEAT);
      chargeAmpsHeaterCooler.updateCharacteristic(C.CurrentTemperature, 16);
      chargeAmpsHeaterCooler.updateCharacteristic(C.HeatingThresholdTemperature, 16);
    }

    // Max Range Charge (momentary button)
    let maxRangeService = accessory.getServiceById(S.Switch, "maxrange") || accessory.addService(S.Switch,  n("Max Range Charge"), "maxrange");
    maxRangeService.setCharacteristic(C.Name, n("Max Range Charge"));
    maxRangeService.getCharacteristic(C.On).onGet(() => false);
    maxRangeService.getCharacteristic(C.On).onSet(async (value) => {
      if (!value) return;
      try {
        await this._ensureAwake();
        await this.tesla.chargeMaxRange(this.vehicleId);
        this.log("Charge max range activated");
        setTimeout(() => maxRangeService.updateCharacteristic(C.On, false), 2000);
      } catch (e) { this.log("Max range error: " + e.message); }
    });

    // Boombox (momentary button)
    let boomboxService = accessory.getServiceById(S.Switch, "boombox") || accessory.addService(S.Switch, n("Boombox"), "boombox");
    boomboxService.setCharacteristic(C.Name, n("Boombox"));
    boomboxService.getCharacteristic(C.On).onGet(() => false);
    boomboxService.getCharacteristic(C.On).onSet(async (value) => {
      if (!value) return;
      try {
        await this._ensureAwake();
        await this.tesla.boombox(this.vehicleId);
        this.log("Boombox activated");
        setTimeout(() => boomboxService.updateCharacteristic(C.On, false), 2000);
      } catch (e) { this.log("Boombox error: " + e.message); }
    });

  // Battery Level tile as HumiditySensor
  const oldBattTemp = accessory.getServiceById(S.TemperatureSensor, "batterypct");
  if (oldBattTemp) accessory.removeService(oldBattTemp);
  const oldBattThermo = accessory.getServiceById(S.Thermostat, "batterypct");
  if (oldBattThermo) accessory.removeService(oldBattThermo);
  if (this.batteryTile) {
    let batteryHumidity =
      accessory.getServiceById(S.HumiditySensor, "batterypct") ||
      accessory.addService(S.HumiditySensor, n("Battery Level"), "batterypct");
    batteryHumidity.setCharacteristic(C.Name, n("Battery Level"));
    batteryHumidity.getCharacteristic(C.CurrentRelativeHumidity).setProps({
      minValue: 0,
      maxValue: 100,
      minStep: 1
    });
    batteryHumidity.updateCharacteristic(C.CurrentRelativeHumidity, 0);
  } else {
    const oldBattHumidity = accessory.getServiceById(S.HumiditySensor, "batterypct");
    if (oldBattHumidity) accessory.removeService(oldBattHumidity);
  }

  // Home presence (OccupancySensor): detected when the car is within home_radius of home_lat/home_long
  if (this.homeEnabled) {
    let homeService =
      accessory.getServiceById(S.OccupancySensor, "carathome") ||
      accessory.addService(S.OccupancySensor, n("At Home"), "carathome");
    homeService.setCharacteristic(C.Name, n("At Home"));
  } else {
    const oldHome = accessory.getServiceById(S.OccupancySensor, "carathome");
    if (oldHome) accessory.removeService(oldHome);
  }

  // Battery Service native
  let batteryService = accessory.getService(S.Battery) || accessory.addService(S.Battery, n("Battery"), "battery");

    // Info
    let infoService = accessory.getService(S.AccessoryInformation) || accessory.addService(S.AccessoryInformation);
    infoService.setCharacteristic(C.Manufacturer, "Tesla");
    infoService.setCharacteristic(C.Model, "Vehicle");
    infoService.setCharacteristic(C.SerialNumber, this.config.vin || "Unknown");
    infoService.setCharacteristic(C.FirmwareRevision, "1.4.2");
  }

  _updateLockState(lockService, locked) {
    const C = this.Characteristic;
    // Keep HomeKit and the local cache in sync after Tesla accepts the command.
    if (this.vehicleData && this.vehicleData.vehicle_state) {
      this.vehicleData.vehicle_state.locked = locked;
    }
    lockService.updateCharacteristic(C.LockCurrentState, locked ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED);
    lockService.updateCharacteristic(C.LockTargetState, locked ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED);
  }

  async _ensureAwake() {
    const lastPoll = this._lastPollTime || 0;
    const elapsed = Date.now() - lastPoll;
    if (this.vehicleData && this.vehicleData.state === "online" && elapsed < 120000) return;
    this.log("Vehicle may be asleep (last poll " + Math.round(elapsed/1000) + "s ago), waking...");
    await this.tesla.wakeUp(this.vehicleId);
    if (this.vehicleData) this.vehicleData.state = "online";
  }

  async startPolling() {
    if (this.pollingStarted) {
      this.log("Polling already started - ignoring duplicate start request");
      return;
    }
    this.pollingStarted = true;

    const isVehicleUnavailable = (result) => {
      if (!result) return false;
      const message = String(result.error || result.error_description || result.message || "").toLowerCase();
      return result.httpStatus === 408 || message.includes("vehicle unavailable") || message.includes("offline") || message.includes("asleep");
    };

    const scheduleOfflineRetry = () => {
      if (this.offlineRetryTimer) {
        this.log("Vehicle data retry is already scheduled - not scheduling another");
        return;
      }
      this.log("Vehicle is offline/asleep - keeping cached HomeKit data and scheduling one retry in 5 minutes (no wake-up)");
      this.offlineRetryTimer = setTimeout(() => {
        this.offlineRetryTimer = null;
        poll(true);
      }, this.offlineRetryDelay);
    };

    const poll = async (isOfflineRetry = false) => {
      if (this.pollInProgress) {
        this.log((isOfflineRetry ? "Offline retry" : "Scheduled poll") + " skipped because another vehicle data poll is in progress");
        return;
      }
      if (!isOfflineRetry && this.offlineRetryTimer) {
        this.log("Scheduled poll skipped because the offline retry is pending");
        return;
      }
      this.pollInProgress = true;
      try {
        this.log(isOfflineRetry ? "Retrying vehicle data without waking the vehicle..." : "Polling vehicle data...");
        const r = await this.tesla.getVehicleData(this.vehicleId, this.homeEnabled);
        if (isVehicleUnavailable(r)) {
          if (isOfflineRetry) {
            this.log("Vehicle data retry result: vehicle is still offline/asleep - keeping cached HomeKit data and returning to the normal polling cycle");
          } else {
            scheduleOfflineRetry();
          }
        } else if (r && r.response) {
          this.vehicleData = r.response;
          this._lastPollTime = Date.now();
          this.log((isOfflineRetry ? "Vehicle data retry succeeded" : "Got vehicle data") + " - battery: " + (r.response.charge_state ? r.response.charge_state.battery_level + "%" : "n/a") + ", locked: " + (r.response.vehicle_state ? r.response.vehicle_state.locked : "n/a"));
          this.updateAccessories();
        } else if (r) {
          if (r.charge_state || r.vehicle_state || r.climate_state) {
            this.vehicleData = r;
            this._lastPollTime = Date.now();
            this.log((isOfflineRetry ? "Vehicle data retry succeeded (unwrapped)" : "Got vehicle data (unwrapped)") + " - battery: " + (r.charge_state ? r.charge_state.battery_level + "%" : "n/a"));
            this.updateAccessories();
          } else {
            this.log((isOfflineRetry ? "Vehicle data retry" : "Poll") + " returned unexpected format: " + JSON.stringify(r).substring(0, 200));
          }
        }
      } catch (e) {
        if (isVehicleUnavailable({ httpStatus: e.status || e.statusCode, error: e.message })) {
          if (isOfflineRetry) {
            this.log("Vehicle data retry result: vehicle is still offline/asleep - keeping cached HomeKit data and returning to the normal polling cycle");
          } else {
            scheduleOfflineRetry();
          }
        } else {
          this.log((isOfflineRetry ? "Vehicle data retry error: " : "Poll error: ") + e.message);
        }
      } finally {
        this.pollInProgress = false;
      }
    };
    try { await poll(); } catch (e) { this.log("Initial poll failed: " + e.message); }
    setInterval(poll, this.pollInterval);
  }

  
    _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  _ampsToBrightness(amps) {
    const ampsMin = 5;
    const ampsMax = 32;

    const safeAmps = this._clamp(
      Number(amps) || 16,
      ampsMin,
      ampsMax
    );

    return this._clamp(
      Math.round(((safeAmps - ampsMin) / (ampsMax - ampsMin)) * 100),
      0,
      100
    );
  }

  _brightnessToAmps(brightness) {
    const ampsMin = 5;
    const ampsMax = 32;

    const safeBrightness = this._clamp(
      Number(brightness) || 0,
      0,
      100
    );

    return this._clamp(
      Math.round(
        ampsMin + ((safeBrightness / 100) * (ampsMax - ampsMin))
      ),
      ampsMin,
      ampsMax
    );
  }

  _distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const rad = (d) => d * Math.PI / 180;
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  _isAtHome() {
    const ds = this.vehicleData && this.vehicleData.drive_state;
    if (!ds || typeof ds.latitude !== "number" || typeof ds.longitude !== "number") return null;
    const d = this._distanceMeters(ds.latitude, ds.longitude, this.homeLatitude, this.homeLongitude);
    return d <= this.homeRadiusMeters;
  }

  updateAccessories() {
    this.log("updateAccessories called");
    if (!this.vehicleData) return;
    const C = this.Characteristic;
    const S = this.Service;
    for (const acc of this.accessories) {
      // At home (location)
      const homeService = acc.getServiceById(S.OccupancySensor, "carathome");
      if (homeService) {
        const atHome = this._isAtHome();
        if (atHome === null) {
          this.log("No location in vehicle data (check the vehicle_location scope and location_data)");
        } else {
          homeService.updateCharacteristic(C.OccupancyDetected, atHome ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
        }
      }

      // Lock
      const lockService = acc.getService(S.LockMechanism);
      if (lockService && this.vehicleData.vehicle_state) {
        const locked = this.vehicleData.vehicle_state.locked;
        lockService.updateCharacteristic(C.LockCurrentState, locked ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED);
        lockService.updateCharacteristic(C.LockTargetState, locked ? C.LockTargetState.SECURED : C.LockTargetState.UNSECURED);
      }


      // Climate
      const thermoService = acc.getService(S.Thermostat);
      if (thermoService && this.vehicleData.climate_state) {
        const cs = this.vehicleData.climate_state;
        const isOn = cs.is_climate_on;
        thermoService.updateCharacteristic(C.CurrentHeatingCoolingState, isOn ? C.CurrentHeatingCoolingState.HEAT : C.CurrentHeatingCoolingState.OFF);
        if (cs.inside_temp !== undefined) thermoService.updateCharacteristic(C.CurrentTemperature, cs.inside_temp);
        if (cs.driver_temp_setting !== undefined) thermoService.updateCharacteristic(C.TargetTemperature, cs.driver_temp_setting);
      }

      // Sentry
      const sentryService = acc.getServiceById(S.Switch, "sentry");
      if (sentryService && this.vehicleData.vehicle_state) {
        sentryService.updateCharacteristic(C.On, !!this.vehicleData.vehicle_state.sentry_mode);
      }

      // Charging
      const chargingService = acc.getServiceById(S.Switch, "charging");
      if (chargingService && this.vehicleData.charge_state) {
        chargingService.updateCharacteristic(C.On, this.vehicleData.charge_state.charging_state === "Charging");
      }

      // Battery % tile
      const batteryHumidity = acc.getServiceById(S.HumiditySensor, "batterypct");
      if (batteryHumidity && this.vehicleData.charge_state) {
        const level = this.vehicleData.charge_state.battery_level || 0;
        batteryHumidity.updateCharacteristic(C.CurrentRelativeHumidity, level);
      }

      // Battery (native service)
      const batteryService = acc.getService(S.Battery);
      if (batteryService && this.vehicleData.charge_state) {
        const level = this.vehicleData.charge_state.battery_level || 0;
        batteryService.updateCharacteristic(C.BatteryLevel, level);
        batteryService.updateCharacteristic(C.StatusLowBattery, level < 20 ? 1 : 0);
        const isCharging = this.vehicleData.charge_state.charging_state === "Charging";
        batteryService.updateCharacteristic(C.ChargingState, isCharging ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING);
      }

      // Charge Limit
      const chargeLimitService = acc.getServiceById(S.Lightbulb, "chargelimit");
      if (chargeLimitService && this.vehicleData.charge_state) {
        const limit = this.vehicleData.charge_state.charge_limit_soc || 80;
        chargeLimitService.updateCharacteristic(C.Brightness, limit);
      }

      // Charge Current
      if (this.vehicleData.charge_state) {
        const amps = this.vehicleData.charge_state.charge_current_request || 16;
        const chargeAmpsService = acc.getServiceById(S.Lightbulb, "chargeamps");
        if (chargeAmpsService) {
          chargeAmpsService.updateCharacteristic(
            C.Brightness,
            this._ampsToBrightness(amps)
          );
        }
        const chargeAmpsHeaterCooler = acc.getServiceById(S.HeaterCooler, "chargeamps_heatercooler");
        if (chargeAmpsHeaterCooler) {
          chargeAmpsHeaterCooler.updateCharacteristic(C.Active, C.Active.ACTIVE);
          chargeAmpsHeaterCooler.updateCharacteristic(C.CurrentHeaterCoolerState, C.CurrentHeaterCoolerState.HEATING);
          chargeAmpsHeaterCooler.updateCharacteristic(C.TargetHeaterCoolerState, C.TargetHeaterCoolerState.HEAT);
          chargeAmpsHeaterCooler.updateCharacteristic(C.CurrentTemperature, amps);
          chargeAmpsHeaterCooler.updateCharacteristic(C.HeatingThresholdTemperature, amps);
        }
      }
      // Defrost
      const defrostService = acc.getServiceById(S.Switch, "defrost");
      if (defrostService && this.vehicleData.climate_state) {
        defrostService.updateCharacteristic(C.On, !!this.vehicleData.climate_state.defrost_mode);
      }

      // Steering Wheel Heater
      const steeringService = acc.getServiceById(S.Switch, "steeringheater");
      if (steeringService && this.vehicleData.climate_state) {
        steeringService.updateCharacteristic(C.On, !!this.vehicleData.climate_state.steering_wheel_heater);
      }

      // Windows (vent state)
      const ventService = acc.getServiceById(S.Switch, "vent");
      if (ventService && this.vehicleData.vehicle_state) {
        const vs = this.vehicleData.vehicle_state;
        const anyOpen = (vs.fd_window > 0 || vs.fp_window > 0 || vs.rd_window > 0 || vs.rp_window > 0);
        ventService.updateCharacteristic(C.On, anyOpen);
      }
    }
  }
}

exports.TeslaPlatform = TeslaPlatform;
