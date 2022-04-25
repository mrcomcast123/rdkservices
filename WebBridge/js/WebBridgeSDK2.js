
const request_state = {
  PENDING: 'pending'
};

class JsonRpcClient
{
  constructor(uri, protocols) {
    this._uri = uri;
    this._websocket = null;
    this._next_request_id = 1;
    this._outstanding_requests = {};
    this._json_rpc_version = "2.0";
    this._sub_protocols = protocols;
  }

  open() {
    let promise = new Promise((resolve, reject) => {
      const self = this;
      self._websocket = new WebSocket(self._uri, self._sub_protocols);
      self._websocket.onopen = function(e) {
        resolve(e);
      };
      self._websocket.onerror = function(e) {
        reject(e);
      };
      self._websocket.onmessage = function(e) {
        self._onIncomingMessage(e);
      };
    });
    return promise;
  }

  sendRequest(method_name, method_params, user_data) {
    console.log("WMR JsonRpcClient::sendRequest");
    const self = this;
    const request_id = self._next_request_id++;
    const request_message = {
      jsonrpc: self._json_rpc_version,
      id: request_id,
      method: method_name,
      params: method_params
    };

    let async_ctx = {};
    async_ctx.state = request_state.PENDING;
    async_ctx.user_data = user_data;
    async_ctx.resolve = null;
    async_ctx.reject = null;

    let promise = new Promise((resolve, reject) => {
      async_ctx.resolve = resolve;
      async_ctx.reject = reject;
    });

    self._outstanding_requests[request_id] = async_ctx;
    self.send(request_message);

    return promise;
  }

  notify(event_data) {
    console.log("WMR JsonRpcClient::notify");
    send(event_data);
  }

  send(message) {
    console.log("WMR JsonRpcClient::send");
    const self = this;
    const json_text = JSON.stringify(message);
    console.log(">>> " + json_text);
    self._websocket.send(json_text);
  }

  _onIncomingMessage(e) {
    console.log("WMR JsonRpcClient::_onIncomingMessage");
    const self = this;
    console.log("<<< " + e.data);
    const json = JSON.parse(e.data);
    if (json.id in self._outstanding_requests) {
      const async_ctx = self._outstanding_requests[json.id];
      if (async_ctx.state == request_state.PENDING) {
        const e_res = {};
        e_res.response = json;
        e_res.user_data = async_ctx.user_data;
        async_ctx.resolve(e_res);
      }
      delete self._outstanding_requests[json.id];
    }
    else {
      // TODO: we just got a message with an id that isn't in the 
      // outstanding requests map
    }
  }
}

class Service {
  constructor(name) {
    this.service_name = name;
    this.methods = {};
    this._send_event_function = function() {};
  }

  registerMethod(method_name, method_version, method) {
    const self = this;
    const fq_method_name = method_version + "." + method_name;
    self.methods[fq_method_name] = method;
  }

  notify(event_data) {
  }

  _callMethodByName(method_name, json_rpc_params) {
    const self = this;
    if (self.methods[method_name]) {
      return self.methods[method_name](json_rpc_params);
    }
    else {
      return Promise.reject("method " + method_name + " not found");
    }
  }
}

class ServiceManager {
  constructor(conf) {
    this._json_rpc_client = null;
    this._services = {};
    this._conf = null;
    this._websocket = null;
    this._send = null;
  }

  open(conf) {
    const self = this;
    self._conf = conf;

    var uri = "ws:" + self._conf.host + ":" + self._conf.port + "/jsonrpc";
    self._json_rpc_client = new JsonRpcClient(uri, ["json"]);
    return new Promise((resolve, reject) => {
        self._json_rpc_client.open().then((e) => {
            console.log("_json_rpc_client opened");
            self._controllerCloneService(self._conf.namespace).then((e) => {
                if (e.response.result) {
                    console.log("_controllerCloneService success");
                    self._controllerActivateService(e.user_data).then((e) => {
                        self._connectService(e.user_data);
                        console.log(self._conf.namespace + " cloned service connected");
                        resolve(e);
                    });
                }
                else {
                    console.log("_controllerCloneService failed");
                    // TODO:
                    reject(e);
                }
            });
        });
    });
  }

  registerService(service) {
    const self = this;
    self._services[service.service_name] = service;
  }

  _connectService(service_name) {
    const self = this;
    const service_endpoint = "ws://" + this._conf.host + ":" + this._conf.port + "/Service/" + service_name;
    self.websocket = new WebSocket(service_endpoint, ["json"]);
    self.send = function(obj) {
      const json_text = JSON.stringify(obj);
      console.log(">>> " + json_text);
      console.log("WMR sservice.websocket.send");
      self.websocket.send(json_text);
    }
    self.websocket.onopen = function(e) {
      console.log("WMR sservice.websocket.onopen");
    }

    self.websocket.onmessage = function(e) {
      console.log("WMR sservice.websocket.onmessage");
      try {
        console.log("<<< " + e.data);

        let outter_request = JSON.parse(e.data);
        let inner_request = outter_request.params.request;

        let outter_response = {};
        outter_response.jsonrpc = "2.0";
        outter_response.id = outter_request.id;
        outter_response.result = {};
        outter_response.result.context = outter_request.params.context;

        let inner_response = outter_response.result.response = {};
        inner_response.jsonrpc = "2.0";
        inner_response.id = inner_request.id;

        // TODO: is there a better way to parse this?
        let request_method = inner_request.method.substring(outter_request.method.length + 1);
        console.log("request_method="+request_method);

        const method_tokens = request_method.split(".");
        let service_name = method_tokens[1];
        let method_name = method_tokens[2] + "." + method_tokens[3];
        console.log("service_name="+service_name);
        console.log("method_name="+method_name);
        console.log(self._services);
        let service = self._services[service_name];
        console.log("service:");
        console.log(service);
        service._callMethodByName(method_name, inner_request.params).then(value => {
          inner_response.result = value;
          self._sendResponse(self.websocket, outter_response);
        }).catch(ex => {
          let err = {};
          err.message = "" + ex;
          err.code = -32000;
          inner_response.error = err;
          try {
            self._sendResponse(self.websocket, outter_response);
          }
          catch (send_ex) {
            console.log(send_ex);
          }
        });
      }
      catch (dispatch_ex) {
        console.log(dispatch_ex.stack);
      }
    };
  }

  _controllerActivateService(service_name) {
    const self = this;
    const params = {
      callsign: service_name
    };
    return self._json_rpc_client.sendRequest("Controller.1.activate", params, service_name);
  }

  _sendResponse(soc, res) {
    const json_text = JSON.stringify(res);
    console.log(">>> " + json_text);
    soc.send(json_text);
  }

  _controllerCloneService(service_name) {
    const self = this;
    const params = {
      callsign: "org.rdk.WebBridge",
      newcallsign: service_name
    };
    return self._json_rpc_client.sendRequest("Controller.1.clone", params, service_name);
  }
}

// exports.Service = Service
// exports.ServiceManager = ServiceManager
