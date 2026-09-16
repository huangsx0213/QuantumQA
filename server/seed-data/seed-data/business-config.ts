import type {
  ApiEndpoint,
  BodyTemplate,
  DynamicVariable,
  HeaderProfile,
  Project,
  Settings,
  TestSuite,
} from '../../shared/contracts/index.ts';

export interface SeedEnvironment {
  name: string;
  variables: Record<string, string>;
}

export interface BusinessConfigSeed {
  environments: SeedEnvironment[];
  settings: Settings[];
  projects: Project[];
  suites: TestSuite[];
  headers: HeaderProfile[];
  bodies: BodyTemplate[];
  endpoints: ApiEndpoint[];
  dynamicVariables: Array<Pick<DynamicVariable, 'id' | 'projectId' | 'name' | 'expression' | 'description' | 'evaluationStrategy'>>;
}

export const businessConfigSeed: BusinessConfigSeed = {
  "environments": [
    {
      "name": "DEV",
      "variables": {}
    },
    {
      "name": "PROD",
      "variables": {}
    }
  ],
  "settings": [
    {
      "id": "global",
      "currentProjectId": "p-aut-demo",
      "currentEnvironment": "DEV",
      "headlessMode": true,
      "viewportWidth": 1920,
      "viewportHeight": 1080,
      "recordVideo": true
    }
  ],
  "projects": [
    {
      "id": "p-sauce-demo",
      "name": "Sauce Labs Demo",
      "description": "E2E test project for https://www.saucedemo.com (Swag Labs) with API Health Checks.",
      "pages": [
        {
          "id": "pg-sauce-login",
          "name": "Login Page",
          "description": "Initial login screen.",
          "elements": [
            {
              "id": "el-sauce-user",
              "name": "Username",
              "selectorType": "getByPlaceholder",
              "value": "Username",
              "description": ""
            },
            {
              "id": "el-sauce-pass",
              "name": "Password",
              "selectorType": "getByPlaceholder",
              "value": "Password",
              "description": ""
            },
            {
              "id": "el-sauce-login-btn",
              "name": "Login Button",
              "selectorType": "CSS",
              "value": "#login-button",
              "description": ""
            }
          ]
        },
        {
          "id": "pg-sauce-products",
          "name": "Products Page",
          "description": "Main inventory list.",
          "elements": [
            {
              "id": "el-sauce-inventory",
              "name": "Inventory List",
              "selectorType": "CSS",
              "value": ".inventory_list",
              "description": ""
            },
            {
              "id": "el-sauce-item-card",
              "name": "Item Card",
              "selectorType": "CSS",
              "value": ".inventory_item",
              "description": ""
            },
            {
              "id": "el-sauce-add-backpack",
              "name": "Add Backpack",
              "selectorType": "CSS",
              "value": "#add-to-cart-sauce-labs-backpack",
              "description": ""
            },
            {
              "id": "el-sauce-cart-badge",
              "name": "Cart Badge",
              "selectorType": "CSS",
              "value": ".shopping_cart_badge",
              "description": ""
            },
            {
              "id": "el-sauce-cart-link",
              "name": "Cart Link",
              "selectorType": "CSS",
              "value": ".shopping_cart_link",
              "description": ""
            }
          ]
        },
        {
          "id": "pg-sauce-cart",
          "name": "Cart Page",
          "description": "Review items in cart.",
          "elements": [
            {
              "id": "el-sauce-checkout-btn",
              "name": "Checkout Button",
              "selectorType": "CSS",
              "value": "#checkout",
              "description": ""
            }
          ]
        },
        {
          "id": "pg-sauce-checkout-1",
          "name": "Checkout Info",
          "description": "Customer information form.",
          "elements": [
            {
              "id": "el-sauce-first-name",
              "name": "First Name",
              "selectorType": "getByPlaceholder",
              "value": "First Name",
              "description": ""
            },
            {
              "id": "el-sauce-last-name",
              "name": "Last Name",
              "selectorType": "getByPlaceholder",
              "value": "Last Name",
              "description": ""
            },
            {
              "id": "el-sauce-zip",
              "name": "Zip Code",
              "selectorType": "getByPlaceholder",
              "value": "Zip/Postal Code",
              "description": ""
            },
            {
              "id": "el-sauce-continue",
              "name": "Continue Button",
              "selectorType": "CSS",
              "value": "#continue",
              "description": ""
            }
          ]
        },
        {
          "id": "pg-sauce-checkout-2",
          "name": "Checkout Overview",
          "description": "Order summary and finish.",
          "elements": [
            {
              "id": "el-sauce-finish",
              "name": "Finish Button",
              "selectorType": "CSS",
              "value": "#finish",
              "description": ""
            }
          ]
        },
        {
          "id": "pg-sauce-complete",
          "name": "Checkout Complete",
          "description": "Confirmation page.",
          "elements": [
            {
              "id": "el-sauce-complete-header",
              "name": "Complete Header",
              "selectorType": "CSS",
              "value": ".complete-header",
              "description": ""
            }
          ]
        }
      ],
      "modules": [
        {
          "id": "mod-sauce-login",
          "name": "Sauce Login",
          "description": "Standard login flow for Sauce Demo.",
          "params": [
            {
              "id": "param-sauce-user",
              "name": "USER",
              "defaultValue": "standard_user",
              "description": ""
            },
            {
              "id": "param-sauce-pass",
              "name": "PASS",
              "defaultValue": "secret_sauce",
              "description": ""
            }
          ],
          "steps": [
            {
              "id": "s-sauce-open",
              "action": "goto",
              "target": "",
              "data": "https://www.saucedemo.com",
              "description": "Open site",
              "screenshot": false,
              "enabled": true
            },
            {
              "id": "s-sauce-type-user",
              "action": "fill",
              "target": "Login Page.Username",
              "data": "{{USER}}",
              "description": "",
              "screenshot": false,
              "enabled": true
            },
            {
              "id": "s-sauce-type-pass",
              "action": "fill",
              "target": "Login Page.Password",
              "data": "{{PASS}}",
              "description": "",
              "screenshot": false,
              "enabled": true
            },
            {
              "id": "s-sauce-click-login",
              "action": "click",
              "target": "Login Page.Login Button",
              "data": "",
              "description": "",
              "screenshot": true,
              "enabled": true
            }
          ]
        },
        {
          "id": "mod-sauce-checkout",
          "name": "Fast Checkout",
          "description": "Fills info and finishes order.",
          "params": [
            {
              "id": "param-sauce-fname",
              "name": "FNAME",
              "defaultValue": "John",
              "description": ""
            },
            {
              "id": "param-sauce-lname",
              "name": "LNAME",
              "defaultValue": "Doe",
              "description": ""
            },
            {
              "id": "param-sauce-zip",
              "name": "ZIP",
              "defaultValue": "12345",
              "description": ""
            }
          ],
          "steps": [
            {
              "id": "s-sauce-type-fname",
              "action": "fill",
              "target": "Checkout Info.First Name",
              "data": "{{FNAME}}",
              "description": "",
              "screenshot": false,
              "enabled": true
            },
            {
              "id": "s-sauce-type-lname",
              "action": "fill",
              "target": "Checkout Info.Last Name",
              "data": "{{LNAME}}",
              "description": "",
              "screenshot": false,
              "enabled": true
            },
            {
              "id": "s-sauce-type-zip",
              "action": "fill",
              "target": "Checkout Info.Zip Code",
              "data": "{{ZIP}}",
              "description": "",
              "screenshot": false,
              "enabled": true
            },
            {
              "id": "s-sauce-click-cont",
              "action": "click",
              "target": "Checkout Info.Continue Button",
              "data": "",
              "description": "",
              "screenshot": false,
              "enabled": true
            },
            {
              "id": "s-sauce-click-finish",
              "action": "click",
              "target": "Checkout Overview.Finish Button",
              "data": "",
              "description": "",
              "screenshot": true,
              "enabled": true
            }
          ]
        }
      ],
      "scenarios": [
        {
          "id": "scenario-sauce-regression",
          "name": "Sauce Basic Regression",
          "description": "Covers login and primary purchase path after API health check.",
          "variables": [],
          "dataRows": [
            {
              "USER_NAME": "standard_user",
              "USER_PASS": "secret_sauce"
            },
            {
              "USER_NAME": "problem_user",
              "USER_PASS": "secret_sauce"
            }
          ],
          "suites": [
            {
              "id": "sc-suite-sauce-api",
              "suiteId": "suite-sauce-api",
              "variableOverrides": {}
            },
            {
              "id": "sc-suite-sauce-e2e",
              "suiteId": "suite-sauce-e2e",
              "variableOverrides": {}
            }
          ]
        },
        {
          "id": "scenario-sauce-inventory",
          "name": "Sauce Inventory Status",
          "description": "Verifies product list and cart persistence with scenario variables.",
          "variables": [
            {
              "id": "v-sc-inv-target",
              "key": "TARGET_USER",
              "value": "standard_user"
            }
          ],
          "dataRows": [
            {
              "TARGET_USER": "standard_user",
              "SORT_OPTION": "Name (A to Z)"
            },
            {
              "TARGET_USER": "problem_user",
              "SORT_OPTION": "Price (low to high)"
            }
          ],
          "suites": [
            {
              "id": "sc-suite-sauce-inv",
              "suiteId": "suite-sauce-inventory",
              "variableOverrides": {}
            }
          ]
        }
      ],
      "plans": [
        {
          "id": "plan-sauce-daily",
          "projectId": "p-sauce-demo",
          "name": "Daily Full Regression",
          "description": "Runs basic regression and API health checks daily.",
          "scenarios": [
            {
              "id": "p-sc-sauce-reg",
              "scenarioId": "scenario-sauce-regression"
            }
          ]
        },
        {
          "id": "plan-sauce-quick-smoke",
          "projectId": "p-sauce-demo",
          "name": "Quick Smoke Check",
          "description": "Rapid verification of inventory and core UI.",
          "scenarios": [
            {
              "id": "p-sc-sauce-inv",
              "scenarioId": "scenario-sauce-inventory"
            }
          ]
        }
      ]
    },
    {
      "id": "p-aut-demo",
      "name": "AUT Demo Application",
      "description": "A demo Application Under Test (AUT) with authentication, user management CRUD, dashboard, and reports for integration testing.",
      "pages": [
        {
          "id": "pg-1779007607929-a05bc633",
          "name": "aut_login",
          "description": "",
          "elements": [
            {
              "id": "el-1779007607929-140227a3",
              "name": "textbox: Username",
              "selectorType": "official",
              "value": "internal:role=textbox[name=\"Username\"i]",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut/login",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:role=textbox[name=\"Username\"i]"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:role=textbox[name=\"Username\"i]"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:role=textbox[name=\"Username\"i]"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut/login",
                  "timestamp": 20618732.502
                }
              }
            },
            {
              "id": "el-1779007611312-f86c5ada",
              "name": "textbox: Password",
              "selectorType": "official",
              "value": "internal:role=textbox[name=\"Password\"i]",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut/login",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:role=textbox[name=\"Password\"i]"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:role=textbox[name=\"Password\"i]"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:role=textbox[name=\"Password\"i]"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut/login",
                  "timestamp": 20621406.409
                }
              }
            },
            {
              "id": "el-1779007611337-941af764",
              "name": "checkbox: Remember me",
              "selectorType": "official",
              "value": "internal:role=checkbox[name=\"Remember me\"i]",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut/login",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:role=checkbox[name=\"Remember me\"i]"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:role=checkbox[name=\"Remember me\"i]"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:role=checkbox[name=\"Remember me\"i]"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut/login",
                  "timestamp": 20624789.438
                }
              }
            },
            {
              "id": "el-1779007613805-84541e5e",
              "name": "button: Sign in",
              "selectorType": "official",
              "value": "internal:role=button[name=\"Sign in\"i]",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut/login",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:role=button[name=\"Sign in\"i]"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:role=button[name=\"Sign in\"i]"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:role=button[name=\"Sign in\"i]"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut/login",
                  "timestamp": 20625525.957
                }
              }
            }
          ]
        },
        {
          "id": "pg-1779007616102-fa9fc603",
          "name": "aut",
          "description": "",
          "elements": [
            {
              "id": "el-1779007616102-18353e59",
              "name": "link: User Management",
              "selectorType": "official",
              "value": "internal:role=link[name=\"User Management\"i]",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:role=link[name=\"User Management\"i]"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:role=link[name=\"User Management\"i]"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:role=link[name=\"User Management\"i]"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut",
                  "timestamp": 20627282.562
                }
              }
            }
          ]
        },
        {
          "id": "pg-1779007623949-d39f7863",
          "name": "aut_users",
          "description": "",
          "elements": [
            {
              "id": "el-1779007623949-045edf7a",
              "name": "textbox: Search by name",
              "selectorType": "official",
              "value": "internal:role=textbox[name=\"Search by name\"i]",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut/users",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:role=textbox[name=\"Search by name\"i]"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:role=textbox[name=\"Search by name\"i]"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:role=textbox[name=\"Search by name\"i]"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut/users",
                  "timestamp": 20629579.218
                }
              }
            },
            {
              "id": "el-1779007623974-5a31ac34",
              "name": "label: Filter by role",
              "selectorType": "official",
              "value": "internal:label=\"Filter by role\"i",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut/users",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:label=\"Filter by role\"i"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:label=\"Filter by role\"i"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:label=\"Filter by role\"i"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut/users",
                  "timestamp": 20637427.292
                }
              }
            },
            {
              "id": "el-1779007626200-eb2a5f0b",
              "name": "label: Filter by status",
              "selectorType": "official",
              "value": "internal:label=\"Filter by status\"i",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut/users",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:label=\"Filter by status\"i"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:label=\"Filter by status\"i"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:label=\"Filter by status\"i"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut/users",
                  "timestamp": 20639677.962
                }
              }
            },
            {
              "id": "el-1779007629812-c91e3672",
              "name": "button: Apply",
              "selectorType": "official",
              "value": "internal:role=button[name=\"Apply\"i]",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut/users",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:role=button[name=\"Apply\"i]"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:role=button[name=\"Apply\"i]"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:role=button[name=\"Apply\"i]"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut/users",
                  "timestamp": 20640597.365
                }
              }
            },
            {
              "id": "el-1779007632623-bcc609b3",
              "name": "link: Reports",
              "selectorType": "official",
              "value": "internal:role=link[name=\"Reports\"i]",
              "description": "",
              "pageUrl": "http://10.191.111.249:3000/aut/users",
              "metadata": {
                "recorder": {
                  "locator": {
                    "kind": "official",
                    "selector": "internal:role=link[name=\"Reports\"i]"
                  },
                  "locatorCandidates": [
                    {
                      "kind": "official",
                      "selector": "internal:role=link[name=\"Reports\"i]"
                    }
                  ],
                  "legacyLocator": {
                    "selectorType": "official",
                    "value": "internal:role=link[name=\"Reports\"i]"
                  },
                  "framePath": [],
                  "pageUrl": "http://10.191.111.249:3000/aut/users",
                  "timestamp": 20643290.349
                }
              }
            }
          ]
        }
      ],
      "modules": [],
      "scenarios": [
        {
          "id": "scenario-1779009243126",
          "name": "Daily Regression",
          "description": "Daily Regression",
          "variables": [
            {
              "id": "var-import-var-1779009291254-1779009321254-964",
              "key": "user_name",
              "value": ""
            },
            {
              "id": "var-import-var-1779009300086-1779009321254-817",
              "key": "password",
              "value": ""
            }
          ],
          "dataRows": [
            {
              "user_name": "admin",
              "password": "admin123"
            },
            {
              "user_name": "admin",
              "password": "admin124"
            }
          ],
          "suites": [
            {
              "id": "ss-1779009265437",
              "suiteId": "suite-1779006022053",
              "variableOverrides": {}
            },
            {
              "id": "ss-1779009266366",
              "suiteId": "suite-1779009209854",
              "variableOverrides": {}
            }
          ]
        }
      ],
      "plans": [
        {
          "id": "plan-1779009347430",
          "projectId": "p-aut-demo",
          "name": "Daily Test Plan",
          "description": "Daily Test Plan",
          "scenarios": [
            {
              "id": "ps-1779009367973",
              "scenarioId": "scenario-1779009243126"
            }
          ]
        }
      ]
    }
  ],
  "suites": [
    {
      "id": "suite-sauce-api",
      "projectId": "p-sauce-demo",
      "name": "API Health Check (Sauce)",
      "description": "Verifies API connectivity before running UI tests.",
      "position": 0,
      "cases": [
        {
          "id": "case-sauce-api-get",
          "name": "Health GET",
          "description": "Check connectivity via GET.",
          "steps": [
            {
              "id": "s-sauce-api-get",
              "action": "apiGet",
              "target": "/get",
              "data": "",
              "description": "",
              "headerProfileId": "header-sauce-json",
              "endpointId": "endpoint-sauce-httpbin-get",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            }
          ],
          "setupSteps": [],
          "teardownSteps": []
        },
        {
          "id": "case-sauce-api-post",
          "name": "Health POST",
          "description": "Check connectivity via POST.",
          "steps": [
            {
              "id": "s-sauce-api-post",
              "action": "apiPost",
              "target": "/post",
              "data": "",
              "description": "",
              "headerProfileId": "header-sauce-json",
              "bodyTemplateId": "body-sauce-echo",
              "endpointId": "endpoint-sauce-httpbin-post",
              "screenshot": false,
              "enabled": true,
              "extractors": [
                {
                  "id": "e-post-origin",
                  "name": "ORIGIN_IP",
                  "source": "API_BODY_JSON",
                  "expression": "$.origin",
                  "scope": "CASE"
                }
              ],
              "assertions": [
                {
                  "id": "a-post-status",
                  "source": "API_STATUS",
                  "operator": "EQUALS",
                  "expectedValue": "200"
                },
                {
                  "id": "a-post-body",
                  "source": "API_BODY_JSON",
                  "expression": "$.json.test",
                  "operator": "EQUALS",
                  "expectedValue": "sauce-demo"
                }
              ],
              "metadata": {}
            }
          ],
          "setupSteps": [],
          "teardownSteps": []
        },
        {
          "id": "case-sauce-api-post-fail",
          "name": "Health POST (Failing Assertion)",
          "description": "Check connectivity via POST with a failing assertion.",
          "steps": [
            {
              "id": "s-sauce-api-post-fail",
              "action": "apiPost",
              "target": "/post",
              "data": "",
              "description": "",
              "headerProfileId": "header-sauce-json",
              "bodyTemplateId": "body-sauce-echo",
              "endpointId": "endpoint-sauce-httpbin-post",
              "screenshot": false,
              "enabled": true,
              "assertions": [
                {
                  "id": "a-post-status-fail",
                  "source": "API_STATUS",
                  "operator": "EQUALS",
                  "expectedValue": "200"
                },
                {
                  "id": "a-post-body-fail",
                  "source": "API_BODY_JSON",
                  "expression": "$.json.test",
                  "operator": "EQUALS",
                  "expectedValue": "wrong-value"
                }
              ],
              "metadata": {}
            }
          ],
          "setupSteps": [],
          "teardownSteps": []
        }
      ],
      "variables": [
        {
          "id": "v-sauce-api-base",
          "key": "API_BASE",
          "value": "https://httpbin.org"
        }
      ],
      "dataRows": [],
      "setupSteps": [],
      "teardownSteps": []
    },
    {
      "id": "suite-sauce-e2e",
      "projectId": "p-sauce-demo",
      "name": "Sauce E2E Purchase Flow",
      "description": "Comprehensive test from login to order confirmation.",
      "position": 0,
      "cases": [
        {
          "id": "case-sauce-login",
          "name": "User Login",
          "description": "Verification of successful login.",
          "steps": [
            {
              "id": "step-sauce-login-mod",
              "action": "runModule",
              "target": "mod-sauce-login",
              "data": "{\"USER\":\"{{USER_NAME}}\",\"PASS\":\"{{USER_PASS}}\"}",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-sauce-assert-inv",
              "action": "assertVisible",
              "target": "Products Page.Inventory List",
              "data": "",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            }
          ],
          "setupSteps": [],
          "teardownSteps": []
        },
        {
          "id": "case-sauce-add-to-cart",
          "name": "Add and Checkout",
          "description": "Adds backpack to cart and completes checkout.",
          "steps": [
            {
              "id": "step-sauce-add-bp",
              "action": "click",
              "target": "Products Page.Add Backpack",
              "data": "",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-sauce-assert-badge",
              "action": "assertText",
              "target": "Products Page.Cart Badge",
              "data": "1",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-sauce-goto-cart",
              "action": "click",
              "target": "Products Page.Cart Link",
              "data": "",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-sauce-click-checkout",
              "action": "click",
              "target": "Cart Page.Checkout Button",
              "data": "",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-sauce-checkout-mod",
              "action": "runModule",
              "target": "mod-sauce-checkout",
              "data": "{\"FNAME\":\"Tester\",\"LNAME\":\"Auto\",\"ZIP\":\"90001\"}",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-sauce-assert-complete",
              "action": "assertText",
              "target": "Checkout Complete.Complete Header",
              "data": "Thank you for your order!",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            }
          ],
          "setupSteps": [],
          "teardownSteps": []
        }
      ],
      "variables": [
        {
          "id": "v-sauce-user",
          "key": "USER_NAME",
          "value": "standard_user"
        },
        {
          "id": "v-sauce-pass",
          "key": "USER_PASS",
          "value": "secret_sauce"
        }
      ],
      "dataRows": [
        {
          "USER_NAME": "standard_user",
          "USER_PASS": "secret_sauce"
        },
        {
          "USER_NAME": "problem_user",
          "USER_PASS": "secret_sauce"
        }
      ],
      "setupSteps": [],
      "teardownSteps": []
    },
    {
      "id": "suite-sauce-inventory",
      "projectId": "p-sauce-demo",
      "name": "Inventory Verification",
      "description": "Checks product list state and basic UI components.",
      "position": 0,
      "cases": [
        {
          "id": "case-sauce-verify-list",
          "name": "Verify Products Loaded",
          "description": "Asserts that item cards are visible after login.",
          "steps": [
            {
              "id": "s-sauce-inv-login",
              "action": "runModule",
              "target": "mod-sauce-login",
              "data": "{\"USER\":\"{{TARGET_USER}}\",\"PASS\":\"secret_sauce\"}",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "s-sauce-assert-items",
              "action": "assertVisible",
              "target": "Products Page.Item Card",
              "data": "",
              "description": "",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            }
          ],
          "setupSteps": [],
          "teardownSteps": []
        }
      ],
      "variables": [],
      "dataRows": [],
      "setupSteps": [],
      "teardownSteps": []
    },
    {
      "id": "suite-1779006022053",
      "projectId": "p-aut-demo",
      "name": "Recording API Cases",
      "description": "",
      "position": 0,
      "cases": [
        {
          "id": "case-1779006042349",
          "name": "Login with api",
          "description": "",
          "steps": [
            {
              "id": "step-1779006072778-77eccbeb",
              "action": "apiPost",
              "target": "/aut-api/auth/login",
              "data": "",
              "description": "aut-api_auth_login.POST /aut-api/auth/login",
              "headerProfileId": "hp-1779006072763-3a9bec18",
              "bodyTemplateId": "bt-1779006072772-295ed5af",
              "endpointId": "ep-1779006072753-01812042",
              "screenshot": false,
              "enabled": true,
              "assertions": [
                {
                  "id": "ast-1779006072778-68d1e1c0",
                  "source": "API_STATUS",
                  "operator": "EQUALS",
                  "expectedValue": "200"
                },
                {
                  "id": "274625b4-7d6e-4d1d-80cd-88e50f9caeb6",
                  "source": "API_BODY_JSON",
                  "expression": "$.success",
                  "operator": "EQUALS",
                  "expectedValue": "true"
                }
              ],
              "metadata": {}
            },
            {
              "id": "step-1779006072877-699b4527",
              "action": "apiGet",
              "target": "/aut-api/dashboard/stats",
              "data": "",
              "description": "aut-api_dashboard_stats.GET /aut-api/dashboard/stats",
              "endpointId": "ep-1779006072870-62870e20",
              "screenshot": false,
              "enabled": true,
              "extractors": [
                {
                  "id": "858d6b75-ac08-4c52-87a3-7bc294f3abdd",
                  "name": "is_success",
                  "source": "API_BODY_JSON",
                  "expression": "$.success",
                  "scope": "SUITE"
                }
              ],
              "assertions": [
                {
                  "id": "ast-1779006072877-4b1e9f5f",
                  "source": "API_STATUS",
                  "operator": "EQUALS",
                  "expectedValue": "200"
                }
              ],
              "metadata": {}
            }
          ],
          "setupSteps": [],
          "teardownSteps": []
        }
      ],
      "variables": [],
      "dataRows": [],
      "setupSteps": [],
      "teardownSteps": []
    },
    {
      "id": "suite-1779009209854",
      "projectId": "p-aut-demo",
      "name": "Recording UI Cases",
      "description": "",
      "position": 1,
      "cases": [
        {
          "id": "case-1779009220662",
          "name": "Login with ui",
          "description": "",
          "steps": [
            {
              "id": "step-1779009220662-0",
              "action": "goto",
              "target": "",
              "data": "http://10.191.111.249:3000/aut/login",
              "description": "Navigated to http://10.191.111.249:3000/aut/login",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-1",
              "action": "fill",
              "target": "aut_login.textbox: Username",
              "data": "admin",
              "description": "Type \"admin\" into textbox: Username",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-2",
              "action": "fill",
              "target": "aut_login.textbox: Password",
              "data": "admin123",
              "description": "Type \"admin123\" into textbox: Password",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-3",
              "action": "check",
              "target": "aut_login.checkbox: Remember me",
              "data": "",
              "description": "Check checkbox: Remember me",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-4",
              "action": "click",
              "target": "aut_login.button: Sign in",
              "data": "",
              "description": "Click on button: Sign in",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-5",
              "action": "click",
              "target": "aut.link: User Management",
              "data": "",
              "description": "Click on link: User Management",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-6",
              "action": "fill",
              "target": "aut_users.textbox: Search by name",
              "data": "Vick Huang",
              "description": "Type \"Vick Huang\" into textbox: Search by name",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-7",
              "action": "selectOption",
              "target": "aut_users.label: Filter by role",
              "data": "admin",
              "description": "Select \"admin\" in label: Filter by role",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-8",
              "action": "selectOption",
              "target": "aut_users.label: Filter by status",
              "data": "active",
              "description": "Select \"active\" in label: Filter by status",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-9",
              "action": "click",
              "target": "aut_users.button: Apply",
              "data": "",
              "description": "Click on button: Apply",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            },
            {
              "id": "step-1779009220662-10",
              "action": "click",
              "target": "aut_users.link: Reports",
              "data": "",
              "description": "Click on link: Reports",
              "screenshot": false,
              "enabled": true,
              "metadata": {}
            }
          ],
          "setupSteps": [],
          "teardownSteps": []
        }
      ],
      "variables": [
        {
          "id": "var-1779009291254",
          "key": "user_name",
          "value": ""
        },
        {
          "id": "var-1779009300086",
          "key": "password",
          "value": ""
        }
      ],
      "dataRows": [
        {
          "user_name": "admin",
          "password": "admin123"
        }
      ],
      "setupSteps": [],
      "teardownSteps": []
    }
  ],
  "headers": [
    {
      "id": "header-sauce-json",
      "projectId": "p-sauce-demo",
      "name": "JSON Headers",
      "description": "Standard JSON headers for API tests.",
      "headers": [
        {
          "key": "Content-Type",
          "value": "application/json",
          "enabled": true
        },
        {
          "key": "Accept",
          "value": "application/json",
          "enabled": true
        }
      ]
    },
    {
      "id": "hp-1779006072763-3a9bec18",
      "projectId": "p-aut-demo",
      "name": "POST /auth/login (Headers)",
      "description": "",
      "headers": [
        {
          "key": "content-type",
          "value": "application/json",
          "enabled": true
        }
      ]
    }
  ],
  "bodies": [
    {
      "id": "body-sauce-echo",
      "projectId": "p-sauce-demo",
      "name": "Health Echo Body",
      "description": "Simple echo body.",
      "contentType": "application/json",
      "content": "{\"test\":\"sauce-demo\",\"timestamp\":\"{{TIMESTAMP}}\"}",
      "defaultValues": {
        "TIMESTAMP": "2026-05-17T08:17:20.780Z"
      }
    },
    {
      "id": "bt-1779006072772-295ed5af",
      "projectId": "p-aut-demo",
      "name": "POST /auth/login (Body)",
      "description": "",
      "contentType": "application/json",
      "content": "{\n  \"username\": \"admin\",\n  \"password\": \"admin123\"\n}",
      "defaultValues": {}
    }
  ],
  "endpoints": [
    {
      "id": "endpoint-sauce-httpbin-get",
      "projectId": "p-sauce-demo",
      "name": "httpbin GET",
      "description": "Public echo API.",
      "method": "GET",
      "baseUrls": {
        "DEV": "https://httpbin.org",
        "PROD": "https://httpbin.org"
      },
      "parameters": [
        {
          "key": "source",
          "value": "sauce_demo",
          "enabled": true
        }
      ]
    },
    {
      "id": "endpoint-sauce-httpbin-post",
      "projectId": "p-sauce-demo",
      "name": "httpbin POST",
      "description": "Public echo API.",
      "method": "POST",
      "baseUrls": {
        "DEV": "https://httpbin.org",
        "PROD": "https://httpbin.org"
      },
      "parameters": []
    },
    {
      "id": "ep-1779006072753-01812042",
      "projectId": "p-aut-demo",
      "name": "[POST] /aut-api/auth/login",
      "description": "",
      "method": "POST",
      "baseUrls": {
        "DEV": "http://10.191.111.249:3000"
      },
      "parameters": []
    },
    {
      "id": "ep-1779006072870-62870e20",
      "projectId": "p-aut-demo",
      "name": "[GET] /aut-api/dashboard/stats",
      "description": "",
      "method": "GET",
      "baseUrls": {
        "DEV": "http://10.191.111.249:3000"
      },
      "parameters": []
    }
  ],
  "dynamicVariables": []
};
