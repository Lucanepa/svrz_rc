package app.openvolley.svrzrc

import android.app.Activity
import androidx.core.content.ContextCompat
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class PasskeyArgs {
  lateinit var requestJson: String
}

/**
 * Passkeys for the installed app (src-tauri/src/passkey.rs, src/lib/passkeys.ts).
 * The page's web view cannot hold a passkey for svrz-rc.openvolley.app, so it
 * hands the server's WebAuthn options here and Android's Credential Manager
 * runs the ceremony: the phone's password manager (Google's, Samsung's, or one
 * like Bitwarden) shows its sheet, the fingerprint, face or screen lock
 * unlocks the key, and the answer comes back as the same JSON a browser would
 * send. Google only lets the app at the site's passkeys because
 * https://svrz-rc.openvolley.app/.well-known/assetlinks.json names this app
 * and its signing key.
 *
 * A refusal carries a code the page acts on: cancelled, exists (this phone
 * already holds a passkey for the coach), none (no passkey to sign in with),
 * no-provider (nothing on the phone can keep passkeys), unsupported, error.
 */
@TauriPlugin
class PasskeyPlugin(private val activity: Activity) : Plugin(activity) {
  private val credentials by lazy { CredentialManager.create(activity) }

  @Command
  fun create(invoke: Invoke) {
    val args = invoke.parseArgs(PasskeyArgs::class.java)
    credentials.createCredentialAsync(
      activity,
      CreatePublicKeyCredentialRequest(args.requestJson),
      null,
      ContextCompat.getMainExecutor(activity),
      object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
        override fun onResult(result: CreateCredentialResponse) {
          val response = result as? CreatePublicKeyCredentialResponse
          if (response == null) {
            invoke.reject("not a passkey response", "error")
            return
          }
          invoke.resolve(JSObject().put("responseJson", response.registrationResponseJson))
        }

        override fun onError(e: CreateCredentialException) {
          val code = when (e) {
            is CreateCredentialCancellationException -> "cancelled"
            is CreatePublicKeyCredentialDomException -> when (e.domError) {
              is InvalidStateError -> "exists"
              is NotAllowedError -> "cancelled"
              else -> "error"
            }
            is CreateCredentialNoCreateOptionException,
            is CreateCredentialProviderConfigurationException -> "no-provider"
            is CreateCredentialUnsupportedException -> "unsupported"
            else -> "error"
          }
          invoke.reject("${e.type}: ${e.message ?: ""}", code)
        }
      },
    )
  }

  @Command
  fun get(invoke: Invoke) {
    val args = invoke.parseArgs(PasskeyArgs::class.java)
    credentials.getCredentialAsync(
      activity,
      GetCredentialRequest(listOf(GetPublicKeyCredentialOption(args.requestJson))),
      null,
      ContextCompat.getMainExecutor(activity),
      object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
        override fun onResult(result: GetCredentialResponse) {
          val credential = result.credential as? PublicKeyCredential
          if (credential == null) {
            invoke.reject("not a passkey", "error")
            return
          }
          invoke.resolve(JSObject().put("responseJson", credential.authenticationResponseJson))
        }

        override fun onError(e: GetCredentialException) {
          val code = when (e) {
            is GetCredentialCancellationException -> "cancelled"
            is NoCredentialException -> "none"
            is GetPublicKeyCredentialDomException -> when (e.domError) {
              is NotAllowedError -> "cancelled"
              else -> "error"
            }
            is GetCredentialProviderConfigurationException -> "no-provider"
            is GetCredentialUnsupportedException -> "unsupported"
            else -> "error"
          }
          invoke.reject("${e.type}: ${e.message ?: ""}", code)
        }
      },
    )
  }
}
