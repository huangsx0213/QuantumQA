**Target AUT Demo Application — System Requirements Specification**

Version 1.1 · 2026-10-27 · Basis: code analysis of `aut/` client and server
Frontend base URL: `/aut` (React SPA) · API base: `/aut-api` (Express + JSON file DB)

Delta from v1.0 (exercises version diff): the new "Test data reset endpoint" story adds 2 ACs; 3 ACs are tightened without changing their titles ("Remember me checkbox toggles without side effects", "Wrong password rejected", "Toast auto-dismiss window"); the "XML content type" story is deferred out of scope and becomes DEPRECATED when this version is committed.

Test Data and Preconditions:
- "Fresh seed" is the precondition for all count-specific acceptance criteria: stop the server, delete `aut/server/db.json`, and start the server again. On start with a missing file the backend seeds 18 users (IDs 1–18).
- Fresh-seed composition: IDs 1–3 are fixed — #1 Alice Smith (admin, active, Development/Frontend/React), #2 Bob Jones (editor, inactive, Design/UI), #3 Charlie Brown (viewer, active, Development/Backend/Node). IDs 4–18 are generated ("User 4" … "User 18") with deterministic statuses (inactive for IDs 4, 7, 10, 13, 16) and randomized roles (admin/editor/viewer). Net fresh-seed totals: 18 users, 12 active, 6 inactive (inactive IDs: 2, 4, 7, 10, 13, 16); top-level departments: Development 10, Design 8.
- Role counts (Admins card, pie chart segment sizes) depend on the randomized seed — derive expected values from GET /aut-api/users at runtime instead of hard-coding them.
- Tests that create, update or delete users persist changes to `db.json`; the seed is only recreated when the file is missing at server start. Suites should be order-independent or reset the data file.
- Unless a step states otherwise, all UI flows require an authenticated session (localStorage key `aut_token`).
- Default credentials: admin / admin123 (displayed on the login page); a successful login returns token "fake-jwt-token-12345".

# Authentication and Session Management
## Login form display and layout
As a first-time user
I want to see a clear sign-in form
So that I can identify how to authenticate

#### Login page renders all controls
Given the browser opens /aut/login
When the page finishes loading
Then the page shows the heading "Sign in", the hint "Use admin / admin123 to login", a Username input (id="username", placeholder "Enter username", with a user icon), a Password input (id="password", placeholder "Enter password", with a lock icon and a visibility toggle), a "Remember me" checkbox (id="remember-me"), a "Forgot password?" link, and a "Sign in" submit button (id="submit-login-btn")

#### Password visibility toggle
Given the user is on the login page with the password masked
When the user clicks the visibility toggle (id="toggle-password-btn")
Then the password input type changes to "text" and the icon switches from eye to eye-off
And clicking the toggle again reverts the input to type "password" with the eye icon

#### Remember me checkbox toggles without side effects
Given the user is on the login page
When the user clicks the "Remember me" checkbox
Then the checkbox toggles between checked and unchecked and no network request is issued
And the remembered state is not persisted across page reloads

#### Forgot password link is inert
Given the user is on the login page
When the user clicks the "Forgot password?" link
Then no navigation occurs and the login form remains displayed

## Login with valid credentials
As a registered administrator
I want to sign in with valid credentials
So that I can access the protected application

Test data: username admin, password admin123; on success the API returns token "fake-jwt-token-12345".

#### Successful login with default credentials
Given the login page is displayed
When the user enters "admin" in Username, "admin123" in Password, and clicks "Sign in"
Then a POST to /aut-api/auth/login returns success, the token is stored in localStorage under key "aut_token", and the browser navigates to /aut

#### Authenticated shell after login
Given the user has just signed in successfully
When the /aut dashboard loads
Then the sidebar shows the Home, User Management and Reports navigation items and the Home page is displayed

## Login with empty fields
As a user who may skip a field
I want the form to block incomplete submissions
So that invalid requests are not sent

#### Empty fields validation message
Given the login form is displayed with both fields empty
When the user clicks "Sign in"
Then the error message "Please fill in all required fields." is shown above the form and no login request is sent

#### Single empty field validation
Given the username field is filled and the password field is empty
When the user clicks "Sign in"
Then the message "Please fill in all required fields." is shown and no login request is sent

## Login with invalid credentials
As a security reviewer
I want wrong credentials to be rejected with a clear message
So that unauthorized access is prevented

#### Wrong password rejected
Given the login page is displayed
When the user enters "admin" with a wrong password and clicks "Sign in"
Then the API responds 401 with error "Invalid credentials" and that message is displayed above the form without navigation
And the username field keeps its entered value after the failed attempt

#### Unknown username rejected
Given the login page is displayed
When the user enters an unknown username with any password and clicks "Sign in"
Then the API responds 401 with error "Invalid credentials" and the message is displayed

## Login loading state and network failure
As a user on a slow connection
I want feedback while signing in
So that I do not resubmit or get stuck without information

#### Loading indication during sign in
Given valid credentials are entered
When the user clicks "Sign in" and the request is in flight
Then the submit button label changes to "Signing in...", the button is disabled, and no error message is shown

#### Network failure feedback
Given the /aut-api backend is unreachable
When the user submits the login form
Then the error "Network error occurred" is displayed above the form

## Route protection and sign out
As a signed-in user
I want protected pages guarded and a way to end my session
So that my account is not accessible without login

#### Unauthenticated access redirects to login
Given no token exists in localStorage under "aut_token"
When the user opens /aut, /aut/users or /aut/reports directly
Then the browser is redirected to /aut/login

#### Sign out clears the session
Given the user is authenticated and viewing any protected page
When the user clicks "Sign Out" at the bottom of the sidebar
Then the "aut_token" key is removed from localStorage and the login page is displayed

#### Session survives page reload
Given a valid token exists in localStorage
When the user reloads /aut
Then the dashboard is displayed without a login prompt

# Home Dashboard
## Welcome banner and quick actions
As a signed-in user
I want to land on an orientation page
So that I can reach the main areas quickly

#### Welcome banner content
Given the user is on /aut
When the Home page loads
Then the banner shows the title "Welcome back, Admin!", a description of the central hub, and two action buttons "Manage Users" and "View Reports"

#### Quick actions navigate correctly
Given the Home page is displayed
When the user clicks "Manage Users"
Then the User Management page opens
And when the user clicks "View Reports"
Then the Reports page opens

## Dashboard statistics cards
As a signed-in user
I want to see system statistics at a glance
So that I can assess the current state without opening reports

Test data: with a fresh seed Total Users = 18 and Active Sessions = 12; the role mix is randomized per seed run.

#### Statistics reflect live data
Given the dashboard is displayed
When GET /aut-api/dashboard/stats succeeds
Then the "Total Users" card equals the number of users in the database (18 with a fresh seed), the "Active Sessions" card equals the number of users with status active (12 with a fresh seed), and the "System Status" card shows a green pulsing indicator labelled "All systems operational"

#### Placeholder before data arrives
Given the dashboard has loaded but stats data has not arrived
When the cards render
Then "Total Users" and "Active Sessions" show "-" instead of a number

# User List and Filtering
## User table display
As a signed-in user
I want a readable user table
So that I can scan account information quickly

Test data: after a fresh seed the table draws from 18 users (12 active, 6 inactive) with page size 10.

#### Default table load
Given an authenticated user opens User Management
When the list finishes loading with default settings
Then a table is displayed with the columns selection, Name, Email, Role, Status, Created At, Last Modified and Actions, showing 10 rows sorted by Last Modified descending

#### Status badges by state
Given the user list is displayed
When a row has status active
Then a green "Active" badge with a check icon is shown in the Status column
And rows with status inactive show a gray "Inactive" badge with an X icon

#### Empty result placeholder
Given filters are applied that match no user
When the table refreshes
Then a single row with the text "No users found" replaces the data rows

## Name search filter
As a signed-in user
I want to find users by name fragment
So that I can locate a specific account

#### Filter by name substring
Given the user list is displayed
When the user types a name fragment into "Search Name" and clicks "Apply"
Then only users whose name contains the fragment case-insensitively are listed and pagination resets to page 1

#### Unapplied input does not filter
Given the user typed text into "Search Name" without clicking "Apply"
When the list is refetched (for example after paging)
Then the list is not filtered by the unapplied text

## Role and status filters
As a signed-in user
I want to narrow the list by role and status
So that I can audit account populations

#### Filter by role
Given the user list is displayed
When the user selects "Admin" in the Role dropdown and clicks "Apply"
Then only users with role admin are listed

#### Combined filters are ANDed
Given name, role and status filters are all set
When the user clicks "Apply"
Then only users matching all three conditions are listed

## Reset filters
As a signed-in user
I want to clear all filters in one action
So that I can return to the full list

#### Reset clears inputs and applied filters
Given at least one filter has been applied
When the user clicks "Reset"
Then all filter inputs are emptied, applied filters are cleared, the full unfiltered list is displayed, and pagination returns to page 1

## Column sorting
As a signed-in user
I want to sort the table by any data column
So that I can inspect records in a preferred order

#### First click sorts a new column descending
Given the table is displayed
When the user clicks the "Name" column header
Then rows are sorted by name in descending order and the sort indicator on the Name header turns active

#### Second click flips to ascending
Given the table is currently sorted by "Name" descending
When the user clicks the "Name" header again
Then rows are sorted by name ascending

#### Sortable and non-sortable columns
Given the table is displayed
When inspecting the column headers
Then Name, Email, Role, Status, Created At and Last Modified respond to clicks, while the selection checkbox and Actions columns do not sort

## Pagination
As a signed-in user
I want predictable paging of 10 rows per page
So that I can browse large lists

#### Pagination with seeded data
Given a freshly seeded database and the unfiltered list (18 users)
When the user opens User Management
Then the footer shows "Showing 1 to 10 of 18 users", page buttons "1" and "2" are displayed, and opening page 2 shows the remaining 8 users

#### Boundary buttons disabled
Given the user is on page 1
When inspecting the pagination controls
Then the previous-page button is disabled
And on the last page the next-page button is disabled

#### Selection persists across pages
Given the user selected users on page 1
When the user navigates to page 2
Then the earlier selection remains active and the batch bar still reports the original selected count

## Row selection and batch bar
As a signed-in user
I want to select rows individually or all at once
So that I can operate on multiple accounts

#### Select all on current page
Given page 1 lists 10 users
When the user checks the header checkbox
Then all 10 rows on the current page become selected and the batch action bar appears

#### Batch bar composition
Given at least one user is selected
When the batch bar is displayed
Then it shows the selected count pill and the actions "Delete Selected" and "Deselect", plus "Activate All" or "Deactivate All" when applicable

# User Creation and Editing
## Quick add user
As an administrator
I want to create a user from minimal fields
So that onboarding is fast

#### Quick add minimal flow
Given the user list is displayed
When the user clicks "Quick Add", fills Full Name and Email, optionally adjusts Role and Status, and clicks "Save"
Then a POST /aut-api/users is issued, the toast "User saved successfully" appears, the modal closes, and the new user appears in the refreshed list

#### Quick add defaults
Given the Quick Add modal is open with untouched Role and Status controls
When the user saves with only name and email filled
Then the created user has role "viewer" and status "inactive"

#### Quick add required validation
Given the Quick Add modal is open with empty name or email
When the user clicks "Save"
Then submission is blocked by the required-field validation and no user is created

## Advanced add user
As an administrator
I want a detailed creation form covering all user attributes
So that accounts can be fully configured

#### Advanced form field inventory
Given the user clicks "Advanced Add"
When the "Create Complex Profile" modal opens
Then it contains Full Name, Email Address, Biography, Role select, Department cascader, Contract Period (two date inputs), Preferred Shift time, System Permissions checkboxes, Access Level slider, Account Status radio buttons, Two-Factor Authentication toggle, and a profile picture drop zone

#### Department cascader three-level selection
Given the Advanced Add modal is open
When the user selects Development, then Frontend, then React in the Department cascader
Then the control displays "development / frontend / react" and the dropdown closes

#### Department cascader two-level branch
Given the Advanced Add modal is open
When the user selects Design, then UX Research
Then the control displays "design / ux" and no third level is offered

#### Permissions multi-select
Given the Advanced Add modal is open
When the user checks "View Reports" and "API Access"
Then both permissions are marked selected and both are submitted with the user record

#### Access level slider range
Given the Advanced Add modal is open
When the user drags the Access Level slider
Then the level badge updates live and the submitted value is an integer between 1 and 5

#### Two-factor toggle
Given the Advanced Add modal is open
When the user clicks the Two-Factor Authentication switch
Then the toggle flips between enabled (blue) and disabled (gray) states

#### Avatar selection stays client-side
Given the Advanced Add modal is open
When the user selects an image file via the drop zone or browse control
Then the file name is displayed in the drop zone, and after saving, the avatar file is not included in the request payload

## Async security verification
As an administrator
I want a data verification step before saving
So that obvious conflicts are surfaced

#### Verify User Data flow
Given the Advanced Add modal is open
When the user clicks "Verify User Data"
Then the button shows "Running Security Check..." for about 3 seconds, after which a "Security Check Passed" modal appears, and clicking "Acknowledge" closes it

## View user details
As a signed-in user
I want a read-only profile view
So that I can inspect a full record without risking edits

#### Read-only profile modal
Given the user list is displayed
When the user clicks the eye icon on a row
Then a "User Profile Details" modal shows personal details, job details, system permissions, access level, account status, two-factor state, and created/updated metadata, and no field is editable

## Edit existing user
As an administrator
I want to modify an existing user record
So that account data stays current

#### Edit pre-fills and persists changes
Given a user row is displayed
When the user clicks the edit icon, changes the email address, and clicks "Save Profile"
Then a PUT /aut-api/users/:id is issued with the merged record, and the refreshed list shows the updated email

## Delete user
As an administrator
I want to delete an account with confirmation
So that removal is intentional

#### Delete with confirmation
Given a user row is displayed
When the user clicks the delete icon and confirms the browser dialog "Are you sure you want to delete this user?"
Then a DELETE /aut-api/users/:id is issued, the toast "User deleted successfully" is shown, and the row disappears from the list

#### Cancelled delete keeps the record
Given a delete confirmation dialog is open
When the user dismisses the dialog
Then no request is sent and the user remains in the list

# Batch Operations and User Actions
## Batch status update
As an administrator
I want to activate or deactivate many accounts at once
So that bulk lifecycle changes are efficient

#### Activate all inactive selection
Given the selection contains only inactive users
When the user clicks "Activate All"
Then a batch-update request is issued for the selected IDs, the toast "Updated N users" appears, the selection clears, and the rows display the "Active" badge

#### Deactivate all active selection
Given the selection contains only active users
When the user clicks "Deactivate All"
Then the batch-update sets all selected users to "Inactive" with the success toast

#### Mixed status guard
Given the selection contains both active and inactive users
When the batch bar is displayed
Then the warning "Mixed statuses: Batch status update disabled" is shown and the "Activate All" and "Deactivate All" buttons are not rendered

## Batch delete
As an administrator
I want to delete several accounts at once with confirmation
So that cleanup is quick but safe

#### Batch delete with confirmation
Given 3 users are selected
When the user clicks "Delete Selected" and confirms the dialog "Are you sure you want to delete 3 users?"
Then a batch-delete request is issued, the toast "Deleted 3 users" appears, and the rows are removed from the list

## User action drawer
As an administrator
I want secondary per-user actions in a drawer
So that the row stays uncluttered

#### Send password reset
Given the action drawer is open for a user
When the user clicks "Send Password Reset"
Then the toast "Password reset link sent successfully" appears and the drawer closes

#### Export user data
Given the action drawer is open for user 1
When the user clicks "Export User Data"
Then a JSON file named user_1_export.json is downloaded and the toast "User data exported" is shown

#### Suspend account
Given the action drawer is open for an active user
When the user clicks "Suspend Account" and confirms the dialog "Are you sure you want to suspend this account?"
Then the user status becomes "Inactive" and the toast "Account suspended" is shown

#### Permanently delete from drawer
Given the action drawer is open for a user
When the user clicks "Permanently Delete" and confirms the delete dialog
Then the user is deleted and the toast "User deleted successfully" is shown

## Toast feedback
As a signed-in user
I want consistent operation feedback
So that I know whether an action succeeded

#### Toast auto-dismiss window
Given any operation has shown a toast
When 2 seconds elapse
Then the toast disappears automatically
And a newer toast replaces any toast that is still visible

# Reports and Analytics
## KPI summary cards
As a manager
I want headline metrics on the Reports page
So that I can gauge system usage at a glance

Test data: with a fresh seed Total Users = 18, Active Accounts = 12, Engagement Rate = 67%; the Admins count depends on the randomized seed roles.

#### Reports KPI cards
Given the user opens the Reports page
When GET /aut-api/reports succeeds
Then four cards are displayed: "Total Users", "Active Accounts", "Admins", and "Engagement Rate", where Engagement Rate equals round(active users / total users × 100)% (with a fresh seed the values are 18, 12, seed-dependent, and 67% respectively)

#### Reports loading state
Given the Reports page is loading
When report data has not arrived
Then a spinner is displayed instead of the cards and charts

## Role distribution chart
As a manager
I want the role mix visualized
So that I can spot role imbalance

#### Pie chart renders role distribution
Given report data is loaded
When the page renders
Then a donut chart titled "User Role Distribution" shows one segment per role present in the data, together with a legend naming each role (admin, editor, viewer after a fresh seed)

## Department distribution chart
As a manager
I want headcount by department visualized
So that I can compare team sizes

#### Bar chart renders department counts
Given report data is loaded
When the page renders
Then a bar chart titled "Users by Department" shows one bar per top-level department (Development, Design, or Unassigned) with its user count

# API Robustness and Fault Tolerance
## Authentication API contract
As an API consumer
I want the profile endpoint to enforce its token
So that endpoints are not openly accessible

#### Profile endpoint rejects missing or invalid token
Given the API is running
When GET /aut-api/profile is called without an Authorization header or with an invalid token
Then the API returns 401 with error "Unauthorized"

#### Profile endpoint accepts the valid token
Given the API is running
When GET /aut-api/profile is called with header "Authorization: Bearer fake-jwt-token-12345"
Then the API returns success with the admin profile data

## User API validation contract
As an API consumer
I want deterministic validation errors
So that clients can handle bad input predictably

#### Create user without name
Given the AUT API is running
When POST /aut-api/users is sent without a name field
Then the API returns 400 with error "Name is required and must be a string"

#### Create user without email
Given the AUT API is running
When POST /aut-api/users is sent without an email field
Then the API returns 400 with error "Email is required and must be a string"

#### Get unknown user id
Given the AUT API is running
When GET /aut-api/users/9999 is called
Then the API returns 404 with error "Not found"

## Timeout fault injection
As a test engineer
I want a deliberately slow endpoint
So that client timeout behaviour can be verified

#### Delayed endpoint timing
Given the fault endpoints are available
When GET /aut-api/fault/timeout is called
Then the response arrives after approximately 5 seconds with success true

## Intermittent failure injection
As a test engineer
I want a randomly failing endpoint
So that retry and error handling can be verified

#### Random 500 responses
Given the fault endpoints are available
When GET /aut-api/fault/simulate-500 is called repeatedly
Then approximately half of the calls return 500 "Simulated strict internal failure" and the remainder succeed

## Test data reset endpoint
As a test engineer
I want an endpoint that rewrites the database with the fresh seed
So that suites can start from a known state without manual file surgery

#### Reset endpoint restores the seed state
Given the AUT API is running
When POST /aut-api/test/reset is called
Then the response is 200 with success true, message "Database reset to seed state", data.userCount 18, and db.json is rewritten with the full seed

#### Reset endpoint yields deterministic status counts
Given the database has been mutated by earlier tests (extra users, deletions, status flips)
When POST /aut-api/test/reset is called and the user list is fetched afterwards
Then the totals show exactly 18 users with 12 active and 6 inactive, and the inactive IDs are 2, 4, 7, 10, 13, 16
