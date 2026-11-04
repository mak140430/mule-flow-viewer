"""A made-up Mule 4 project with history and branches, for screenshots and demos (no real code or names).

  python3 tools/demo/make_demo_repo.py <folder>

main: three commits by different people over a few months; qa: main plus a retry change; feature/order-discounts:
a discount route and a changed request mapping, while main changed the same mapping differently (a conflict).
"""
import os
import shutil
import subprocess
import sys

DEST = os.path.abspath(sys.argv[1])
NS = '''xmlns="http://www.mulesoft.org/schema/mule/core" xmlns:http="http://www.mulesoft.org/schema/mule/http"
	xmlns:ee="http://www.mulesoft.org/schema/mule/ee/core" xmlns:doc="http://www.mulesoft.org/schema/mule/documentation"
	xmlns:secure-properties="http://www.mulesoft.org/schema/mule/secure-properties"
	xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'''

GLOBAL = f'''<?xml version="1.0" encoding="UTF-8"?>
<mule {NS}>
	<http:listener-config name="api-httpListenerConfig" doc:name="HTTP Listener config" doc:id="g-1">
		<http:listener-connection host="0.0.0.0" port="${{http.port}}" />
	</http:listener-config>
	<http:request-config name="erp-request-config" doc:name="ERP Request config" doc:id="g-2">
		<http:request-connection host="${{erp.host}}" port="443" protocol="HTTPS" />
		<http:default-headers><http:default-header key="X-Client-Secret" value="${{erp.clientSecret}}" /></http:default-headers>
	</http:request-config>
	<configuration-properties doc:name="Common Properties" doc:id="g-3" file="config/config-common.yaml" />
	<configuration-properties doc:name="Environment Properties" doc:id="g-4" file="config/config-${{mule.env}}.yaml" />
	<secure-properties:config name="Secure_Properties" doc:name="Secure Properties" doc:id="g-5" file="config/config-${{mule.env}}.yaml" key="${{mule.key}}" />
</mule>
'''

def orders(retries="3", discount=False):
    vip = '''
				<when expression="#[payload.customer.tier == 'VIP']">
					<ee:transform doc:name="Apply VIP discount" doc:id="o-vip">
						<ee:message><ee:set-payload resource="dwl/apply-discount.dwl" /></ee:message>
					</ee:transform>
				</when>''' if discount else ""
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<mule {NS}>
	<flow name="orders-api-main" doc:id="o-main">
		<http:listener doc:name="POST /orders" doc:id="o-1" config-ref="api-httpListenerConfig" path="/orders" allowedMethods="POST">
			<http:response statusCode="#[vars.httpStatus default 201]" />
			<http:error-response statusCode="#[vars.httpStatus default 500]" />
		</http:listener>
		<flow-ref doc:name="Create order" doc:id="o-2" name="orders:create-order" />
		<error-handler>
			<on-error-propagate type="HTTP:CONNECTIVITY, RETRY_EXHAUSTED" doc:name="ERP unavailable" doc:id="o-11">
				<set-variable variableName="httpStatus" value="502" doc:name="502" doc:id="o-13" />
				<logger level="ERROR" doc:name="Log ERP error" doc:id="o-12" message="#[error.description]" />
			</on-error-propagate>
			<on-error-propagate type="HTTP:BAD_REQUEST" doc:name="Rejected by the ERP" doc:id="o-14">
				<set-variable variableName="httpStatus" value="400" doc:name="400" doc:id="o-15" />
			</on-error-propagate>
		</error-handler>
	</flow>
	<sub-flow name="orders:create-order" doc:id="o-create">
		<logger level="INFO" doc:name="Start Logger" doc:id="o-3" message="#['Creating order ' ++ (payload.orderNumber default '')]" />
		<set-variable variableName="orderNumber" value="#[payload.orderNumber]" doc:name="Save orderNumber" doc:id="o-4" />
		<choice doc:name="Customer type?" doc:id="o-5">{vip}
			<otherwise>
				<logger level="DEBUG" doc:name="Standard pricing" doc:id="o-6" />
			</otherwise>
		</choice>
		<ee:transform doc:name="Build ERP order" doc:id="o-7">
			<ee:message><ee:set-payload resource="dwl/build-erp-order.dwl" /></ee:message>
		</ee:transform>
		<until-successful maxRetries="{retries}" millisBetweenRetries="2000" doc:name="Until Successful" doc:id="o-8">
			<http:request method="POST" doc:name="Create order in ERP" doc:id="o-9" config-ref="erp-request-config" path="/api/orders" />
		</until-successful>
		<ee:transform doc:name="Build response" doc:id="o-10">
			<ee:message><ee:set-payload resource="dwl/order-response.dwl" /></ee:message>
		</ee:transform>
	</sub-flow>
</mule>
'''

CUSTOMERS = f'''<?xml version="1.0" encoding="UTF-8"?>
<mule {NS}>
	<flow name="customers-sync" doc:id="c-main">
		<scheduler doc:name="Every 15 minutes" doc:id="c-1"><scheduling-strategy><fixed-frequency frequency="15" timeUnit="MINUTES" /></scheduling-strategy></scheduler>
		<http:request method="GET" doc:name="Changed customers" doc:id="c-2" config-ref="erp-request-config" path="/api/customers/changes" />
		<foreach doc:name="For Each customer" doc:id="c-3" collection="#[payload.items]">
			<ee:transform doc:name="Map customer" doc:id="c-4">
				<ee:message><ee:set-payload resource="dwl/map-customer.dwl" /></ee:message>
			</ee:transform>
			<scatter-gather doc:name="Scatter-Gather" doc:id="c-5">
				<route><http:request method="PUT" doc:name="Update CRM" doc:id="c-6" config-ref="erp-request-config" path="/crm/customers" /></route>
				<route><http:request method="PUT" doc:name="Update billing" doc:id="c-7" config-ref="erp-request-config" path="/billing/customers" /></route>
			</scatter-gather>
		</foreach>
		<logger level="INFO" doc:name="Done" doc:id="c-8" message="#['Synced ' ++ sizeOf(payload) ++ ' customers']" />
	</flow>
</mule>
'''

DWL = {
    "build-erp-order.dwl": '''%dw 2.0
output application/json
---
{
  externalId: payload.orderNumber,
  customerId: payload.customer.id,
  lines: payload.items map {
    sku: $.sku,
    quantity: $.qty,
    price: $.price
  },
  total: sum(payload.items map ($.qty * $.price))
}''',
    "order-response.dwl": '''%dw 2.0
output application/json
---
{ orderNumber: vars.orderNumber, erpId: payload.id, status: "CREATED" }''',
    "map-customer.dwl": '''%dw 2.0
output application/json
---
{ id: payload.id, name: payload.firstName ++ " " ++ payload.lastName, email: lower(payload.email) }''',
}
CONFIG = {"config-common.yaml": 'http:\n  port: "8081"\n',
          "config-qa.yaml": 'erp:\n  host: "erp-qa.example.com"\n  clientSecret: "qa-secret-123"\n',
          "config-prod.yaml": 'erp:\n  host: "erp.example.com"\n  clientSecret: "![nN4fQx0lV2kP8sTq1yR7Zw==]"\n'}
MUNIT = f'''<?xml version="1.0" encoding="UTF-8"?>
<mule {NS} xmlns:munit="http://www.mulesoft.org/schema/mule/munit" xmlns:munit-tools="http://www.mulesoft.org/schema/mule/munit-tools">
	<munit:test name="create-order-happy-path" doc:id="t-1">
		<munit:behavior>
			<munit-tools:mock-when processor="http:request" doc:id="t-2">
				<munit-tools:with-attributes><munit-tools:with-attribute attributeName="doc:name" whereValue="Create order in ERP" /></munit-tools:with-attributes>
				<munit-tools:then-return><munit-tools:payload value='#[{{"id": "ERP-1042"}}]' mediaType="application/json" /></munit-tools:then-return>
			</munit-tools:mock-when>
			<munit:set-event doc:id="t-3">
				<munit:payload value='#[{{"orderNumber": "SO-1001", "customer": {{"id": "C-77", "tier": "VIP"}}, "items": [{{"sku": "A-1", "qty": 2, "price": 19.5}}, {{"sku": "B-7", "qty": 1, "price": 120}}]}}]' mediaType="application/json" />
			</munit:set-event>
		</munit:behavior>
		<munit:execution><flow-ref name="orders:create-order" doc:id="t-4" /></munit:execution>
	</munit:test>
</mule>
'''
POM = '''<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId><artifactId>orders-api</artifactId><version>1.0.0</version><packaging>mule-application</packaging>
</project>
'''


def write(path, text):
    full = os.path.join(DEST, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(text)


def commit(msg, who, date):
    name, email = who
    env = {**os.environ, "GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email, "GIT_COMMITTER_NAME": name,
           "GIT_COMMITTER_EMAIL": email, "GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}
    subprocess.run(["git", "add", "-A"], cwd=DEST, check=True)
    subprocess.run(["git", "commit", "-q", "-m", msg], cwd=DEST, check=True, env=env)


def git(*a):
    subprocess.run(["git", *a], cwd=DEST, check=True, capture_output=True)


ALICE, BOB, CHEN = ("Alice Martin", "alice@example.com"), ("Bob Novak", "bob@example.com"), ("Chen Wei", "chen@example.com")
if os.path.exists(DEST):
    shutil.rmtree(DEST)
os.makedirs(DEST)
git("init", "-q", "-b", "main")
write("pom.xml", POM)
write("mule-artifact.json", '{"minMuleVersion": "4.4.0"}\n')
write("src/main/mule/global.xml", GLOBAL)
write("src/main/mule/orders.xml", orders())
for k, v in DWL.items():
    write(f"src/main/resources/dwl/{k}", v)
for k, v in CONFIG.items():
    write(f"src/main/resources/config/{k}", v)
write("src/test/munit/orders-test-suite.xml", MUNIT)
commit("Orders API: create order in the ERP", ALICE, "2026-05-12T10:00:00+02:00")
write("src/main/mule/customers.xml", CUSTOMERS)
commit("Sync changed customers to CRM and billing", BOB, "2026-08-03T15:20:00+02:00")
git("branch", "qa")
git("branch", "feature/order-discounts")
# main changes the ERP mapping
write("src/main/resources/dwl/build-erp-order.dwl", DWL["build-erp-order.dwl"].replace("  total:", "  currency: payload.currency default \"EUR\",\n  total:"))
commit("ERP orders carry a currency", CHEN, "2026-10-21T09:10:00+02:00")
# qa: more retries
git("checkout", "-q", "qa")
write("src/main/mule/orders.xml", orders(retries="5"))
commit("Retry ERP calls five times on qa", BOB, "2026-10-28T11:45:00+02:00")
# the feature branch: a VIP route and a different change to the same mapping
git("checkout", "-q", "feature/order-discounts")
write("src/main/mule/orders.xml", orders(discount=True))
write("src/main/resources/dwl/apply-discount.dwl", '%dw 2.0\noutput application/json\n---\npayload update { case .items -> $ map ($ ++ { price: $.price * (1 - p("discount.vip.rate") as Number) }) }')
write("src/main/resources/config/config-prod.yaml", CONFIG["config-prod.yaml"] + 'discount:\n  vip:\n    rate: "0.1"\n')
write("src/main/resources/dwl/build-erp-order.dwl", DWL["build-erp-order.dwl"].replace("    price: $.price\n", "    price: $.price,\n    discounted: payload.customer.tier == \"VIP\"\n"))
commit("VIP customers get 10% off", ALICE, "2026-11-01T16:30:00+02:00")
git("checkout", "-q", "main")
git("remote", "add", "origin", "git@git.acme.example:acme/orders-api.git")
print(DEST)
