## Default Permission

Default permissions for the Vixera One share/capture plugin.

#### Granted Permissions

Lets the Field read and clear the queue of objects the user explicitly shared
into Vixera, subscribe to the `share` event, and use the device secure store
(Android Keystore-backed) for the Supabase session and device key.

#### This default permission set includes the following:

- `allow-get-pending-shares`
- `allow-clear-pending-shares`
- `allow-secure-get`
- `allow-secure-set`
- `allow-secure-delete`
- `allow-register-listener`
- `allow-remove-listener`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`vixera-share:allow-clear-pending-shares`

</td>
<td>

Enables the clear_pending_shares command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:deny-clear-pending-shares`

</td>
<td>

Denies the clear_pending_shares command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:allow-get-pending-shares`

</td>
<td>

Enables the get_pending_shares command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:deny-get-pending-shares`

</td>
<td>

Denies the get_pending_shares command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:allow-register-listener`

</td>
<td>

Enables the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:deny-register-listener`

</td>
<td>

Denies the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:allow-remove-listener`

</td>
<td>

Enables the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:deny-remove-listener`

</td>
<td>

Denies the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:allow-secure-delete`

</td>
<td>

Enables the secure_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:deny-secure-delete`

</td>
<td>

Denies the secure_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:allow-secure-get`

</td>
<td>

Enables the secure_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:deny-secure-get`

</td>
<td>

Denies the secure_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:allow-secure-set`

</td>
<td>

Enables the secure_set command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`vixera-share:deny-secure-set`

</td>
<td>

Denies the secure_set command without any pre-configured scope.

</td>
</tr>
</table>
