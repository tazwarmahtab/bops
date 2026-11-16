# Frozen Orgo paths for the local computer plane (host/test/routes.test.ts).

* /api/secrets* 501 not_on_this_plane
* /api/computers/{id}/deploy-projects* 404 DEPLOYS_DISABLED
* /api/computers/{id}/deployments* 404 DEPLOYS_DISABLED
* /api/computers/{id}/public-urls* 404 DEPLOYS_DISABLED
* /api/computers/{id}/domains* 404 DEPLOYS_DISABLED
* /api/domains/search 501 not_on_this_plane
* /api/projects/{id}/domains/* 501 not_on_this_plane
GET /api/projects/{id}/domains implement
POST /api/projects/{id}/domains 501 not_on_this_plane
* /api/projects/{id}/crm* 404 no code
* /api/projects/{id}/skills* 404 no code
* /api/workspaces/{id}/skills* 404 no code
* /api/projects/{id}/skill-labels* 404 no code
* /api/projects/{id}/access* 404 no code
* /api/projects/{id}/orbit* 404 no code
* /api/projects/{id}/bops/apps* 404 no code
* /api/bops/credit/* 501 not_on_this_plane
* /api/v1/* 501 not_on_this_plane

GET /api/bops/settings implement
PUT /api/bops/settings implement
GET /api/user/profile implement
PUT /api/projects/{id}/routines implement
GET /api/projects/{id}/routines implement
DELETE /api/projects/{id}/routines/{id} implement
GET /api/projects/{id}/routines/{id}/runs implement
POST /api/projects/{id}/routines/{id}/runs implement

GET /api/projects/{id}/bops implement
POST /api/files/uploads implement
POST /api/files/uploads/complete implement
GET /api/computers/{id}/orgo-key implement
POST /api/bops/computer/active implement
GET /api/workspaces implement
PATCH /api/workspaces/{id} implement
POST /api/workspaces implement
POST /api/computers implement
POST /api/bops/computer/size implement
PATCH /api/computers/{id}/resize implement
POST /api/computers/{id}/restart implement
GET /api/computers/{id}/resize implement
GET /api/computers/{id} implement
POST /api/computers/{id}/webrtc implement
PATCH /api/computers/{id}/screens/{id} implement
GET /api/workspaces/{id} implement
DELETE /api/computers/{id} implement
POST /api/computers/{id}/fork implement
POST /api/computers/{id}/clone implement
GET /api/computers/{id}/screens implement
POST /api/computers/{id}/screens implement
DELETE /api/computers/{id}/screens/{id} implement
POST /api/computers/{id}/bash implement
POST /api/computers/{id}/click implement
POST /api/computers/{id}/type implement
POST /api/computers/{id}/key implement
POST /api/computers/{id}/resume implement
POST /api/projects/{id}/delete implement
GET /api/workspaces/{id}/delete-preview implement
GET /api/computers/{id}/ssh implement
POST /api/computers/{id}/ssh implement
GET /api/egress-devices implement
POST /api/egress-devices implement
GET /api/computers/{id}/egress/upstream implement
POST /api/computers/{id}/egress/upstream implement
POST /api/computers/{id}/residential-proxy implement
GET /api/computers/{id}/screenshot implement
GET /api/workspaces/{id}/members implement
POST /api/workspaces/{id}/invite implement
DELETE /api/workspaces/{id}/invite implement
DELETE /api/workspaces/{id}/members implement
PATCH /api/workspaces/{id}/invite implement
PATCH /api/workspaces/{id}/members implement
PUT /api/computers/{id}/orgo-key implement
DELETE /api/computers/{id}/orgo-key implement
PATCH /api/projects/{id} implement

GET /api/bops/apps 404 no code
PUT /api/{id}/versions/{id} 404 no code
PUT /api/{id}/data 404 no code
GET {id}/approvals 404 no code
GET {id}/{id}/export 404 no code

POST /api/bops/portal 501 not_on_this_plane
POST /api/bops/credit/checkout 501 not_on_this_plane
POST /api/bops/credit/card-on-file 501 not_on_this_plane
GET /api/bops/credit/card-on-file 501 not_on_this_plane